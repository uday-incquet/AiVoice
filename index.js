import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "dotenv";
import twilio from "twilio";
import cors from "cors";

config();

const PORT = process.env.PORT || 5050;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-live-2.5-flash-preview-native-audio-09-2025";

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

if (!GEMINI_KEY) {
    throw new Error("Missing GEMINI_API_KEY in .env");
}

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => res.json({ message: "Twilio + Gemini Live API bridge running" }));

app.get("/token", (req, res) => {
    try {
        const token = new AccessToken(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_API_KEY,
            process.env.TWILIO_API_SECRET,
            {
                identity: 'user123',
                ttl: 86400
            }
        );

        const voiceGrant = new VoiceGrant({
            outgoingApplicationSid: process.env.TWIML_APP_SID,
            incomingAllow: true,
            outgoingAllow: true
        });

        token.addGrant(voiceGrant);
        const jwt = token.toJwt();

        res.json({ token: jwt, identity: 'user123' });
    } catch (error) {
        console.error('Error generating token:', error);
        res.status(500).json({ error: 'Failed to generate token' });
    }
});

app.post("/incoming-call", (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: "Google.en-US-Chirp3-HD-Aoede" }, "Please wait while we connect you to the Gemini voice assistant.");
    twiml.pause({ length: 1 });
    twiml.say({ voice: "Google.en-US-Chirp3-HD-Aoede" }, "Okay — you can start talking now!");
    const connect = twiml.connect();
    connect.stream({ url: `wss://${req.headers.host}/media-stream` });
    res.type("text/xml").send(twiml.toString());
});

/* -------------------------
   Audio codec + utility funcs
-------------------------*/

function mulawDecodeByte(mu) {
    mu = mu ^ 0xFF;
    const sign = (mu & 0x80) ? -1 : 1;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample = sign * (sample - 0x84);
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    return sample;
}

function mulawEncodeSample(sample) {
    const MU_BIAS = 33;
    let sign = 0;
    let pcmVal = sample;

    if (pcmVal < 0) {
        pcmVal = -pcmVal;
        sign = 0x80;
    }
    if (pcmVal > 32635) pcmVal = 32635;

    pcmVal += MU_BIAS;

    let exponent = 7;
    let expMask = 0x4000;
    while ((pcmVal & expMask) === 0 && exponent > 0) {
        exponent--;
        expMask >>= 1;
    }

    const mantissa = (pcmVal >> (exponent + 3)) & 0x0F;
    const mu = ~(sign | (exponent << 4) | mantissa) & 0xFF;
    return mu;
}

function base64ToBuffer(b64) { return Buffer.from(b64, "base64"); }
function bufferToBase64(buf) { return buf.toString("base64"); }

function muLawBufferToPcm16Int16Array(muBuf) {
    const out = new Int16Array(muBuf.length);
    for (let i = 0; i < muBuf.length; i++) {
        out[i] = mulawDecodeByte(muBuf[i]);
    }
    return out;
}

function pcm16Int16ArrayToMuLawBuffer(int16Arr) {
    const out = Buffer.alloc(int16Arr.length);
    for (let i = 0; i < int16Arr.length; i++) {
        out[i] = mulawEncodeSample(int16Arr[i]);
    }
    return out;
}

function upsample8kTo16k(int16Arr8k) {
    const out = new Int16Array(int16Arr8k.length * 2);
    for (let i = 0; i < int16Arr8k.length - 1; i++) {
        const s0 = int16Arr8k[i];
        const s1 = int16Arr8k[i + 1];
        out[2 * i] = s0;
        out[2 * i + 1] = Math.round((s0 + s1) / 2);
    }
    out[out.length - 2] = int16Arr8k[int16Arr8k.length - 1];
    out[out.length - 1] = int16Arr8k[int16Arr8k.length - 1];
    return out;
}

function downsample16kTo8k(int16Arr16k) {
    const out = new Int16Array(Math.ceil(int16Arr16k.length / 2));
    let j = 0;
    for (let i = 0; i < int16Arr16k.length; i += 2) {
        out[j++] = int16Arr16k[i];
    }
    return out;
}

/* -------------------------
   WebSocket bridge
-------------------------*/


const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (twilioWs, req) => {
    console.log("Twilio connected.");

    const liveModel = "models/gemini-2.5-flash-native-audio-preview-09-2025";
    let streamSid = null;
    let session = null;
    let closed = false;
    let sessionReady = false;

    // Queue media frames received before Gemini session is ready
    const pendingMedia = [];
    let startEventPendingPrompt = false;

    // Twilio message handler (attach immediately)
    twilioWs.on("message", (raw) => {
        let event;
        try { event = JSON.parse(raw.toString()); } catch { return; }

        switch (event.event) {
            case "start":
                streamSid = event.start.streamSid;
                console.log("Twilio stream start:", streamSid);
                // We will send initial prompt after Gemini session opens
                startEventPendingPrompt = true;
                break;
            case "media":
                if (!streamSid) return; // ignore until start received
                if (!sessionReady) {
                    // stash media until session ready
                    pendingMedia.push(event);
                } else {
                    forwardTwilioAudioToGemini(event);
                }
                break;
            case "stop":
                console.log("Twilio stream stopped.");
                closed = true;
                try { session?.close(); } catch { }
                break;
            default:
                break;
        }
    });

    twilioWs.on("close", () => {
        console.log("Twilio WS closed.");
        closed = true;
        try { session?.close(); } catch { }
    });

    twilioWs.on("error", (err) => console.error("Twilio WS error:", err));

    // Lazy import Gemini SDK
    let GoogleGenAI;
    try {
        ({ GoogleGenAI } = await import("@google/genai"));
    } catch (e) {
        console.error("Missing @google/genai. Run: npm install @google/genai");
        twilioWs.close();
        return;
    }

    const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

    // Start Gemini live session - REMOVED await to fix timing issue
    try {
        session = ai.live.connect({
            model: liveModel,
            config: {
                responseModalities: ["AUDIO"],
                mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } }
                },
                // Declare input audio format we will send
                inputAudio: { format: "pcm16", sampleRateHertz: 16000 }
            },
            callbacks: {
                onopen: () => {
                    console.log("Gemini Live session opened.");
                    sessionReady = true;

                    // Send initial prompt if Twilio start already happened
                    if (startEventPendingPrompt) {
                        session.sendClientContent({
                            turns: [{
                                role: "user",
                                parts: [{ text: "You are a helpful real-time voice assistant. Greet the caller briefly." }]
                            }]
                        });
                    }

                    // Flush queued media
                    for (const ev of pendingMedia) forwardTwilioAudioToGemini(ev);
                    pendingMedia.length = 0;
                },
                onmessage: (message) => {
                    const parts = message.serverContent?.modelTurn?.parts;
                    if (Array.isArray(parts)) {
                        for (const part of parts) {
                            if (part.inlineData?.mimeType?.startsWith("audio/")) {
                                if (!streamSid) return;
                                const mime = part.inlineData.mimeType;
                                const b64 = part.inlineData.data;
                                if (!b64) return;

                                const pcmBuf = Buffer.from(b64, "base64");

                                // Determine sample rate
                                let rate = 16000;
                                const rateMatch = mime.match(/rate=(\d+)/);
                                if (rateMatch) rate = parseInt(rateMatch[1], 10);

                                // If 24000 Hz -> crude downsample to 16k
                                let int16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.length / 2);
                                if (rate === 24000) {
                                    const targetLen = Math.floor(int16.length * (16000 / 24000));
                                    const tmp = new Int16Array(targetLen);
                                    let j = 0;
                                    for (let i = 0; i < int16.length && j < targetLen; i += 3) {
                                        tmp[j++] = int16[i];
                                    }
                                    int16 = tmp;
                                }

                                // 16k -> 8k for Twilio
                                const int16_8k = downsample16kTo8k(int16);
                                const mulawBuf = pcm16Int16ArrayToMuLawBuffer(int16_8k);

                                twilioWs.send(JSON.stringify({
                                    event: "media",
                                    streamSid,
                                    media: { payload: bufferToBase64(mulawBuf) }
                                }));
                            } else if (part.text) {
                                console.log("Gemini text:", part.text);
                            }
                        }
                    }
                },
                onerror: (e) => console.error("Gemini live error:", e.message),
                onclose: (e) => {
                    console.log("Gemini live closed:", e.reason);
                    if (!closed) twilioWs.close();
                }
            }
        });
    } catch (err) {
        console.error("Failed to open Gemini Live session:", err);
        twilioWs.close();
        return;
    }

    // Helper to forward Twilio audio to Gemini
    function forwardTwilioAudioToGemini(event) {
        if (!session || sessionReady === false) return;
        const muLawBuf = Buffer.from(event.media.payload, "base64");
        const pcm16_8k = muLawBufferToPcm16Int16Array(muLawBuf);
        const pcm16_16k = upsample8kTo16k(pcm16_8k);
        const pcmBuf = Buffer.from(pcm16_16k.buffer);

        session.sendRealtimeInput({
            mediaChunks: [{
                mimeType: "audio/L16;rate=16000",
                data: pcmBuf.toString("base64")
            }]
        });
    }
});


const server = app.listen(PORT, () => console.log(`Server listening on :${PORT}`));

server.on("upgrade", (req, socket, head) => {
    if (req.url === "/media-stream") {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    } else {
        socket.destroy();
    }
});