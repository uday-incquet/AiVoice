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

// ...existing code...
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (twilioWs, req) => {
    console.log("Twilio connected.");

    const liveModel = GEMINI_MODEL.startsWith("models/") ? GEMINI_MODEL : `models/${GEMINI_MODEL}`;
    const baseUrl = `wss://generativelanguage.googleapis.com/v1alpha/${liveModel}:bidiConnect`;

    // Preflight: fetch HTTPS version to see detailed error JSON
    try {
        const httpsUrl = baseUrl.replace("wss://", "https://");
        const pre = await fetch(httpsUrl, { headers: { "X-Goog-Api-Key": GEMINI_KEY } });
        const body = await pre.text();
        console.log("Gemini HTTPS preflight:", pre.status, body.slice(0, 500));
    } catch (e) {
        console.warn("Gemini HTTPS preflight failed:", e.message);
    }

    // WS: use API key in header (no query param). Some deployments reject ?key=
    const geminiWs = new WebSocket(baseUrl, {
        headers: { "X-Goog-Api-Key": GEMINI_KEY },
        perMessageDeflate: false
    });

    let streamSid = null;
    let setupSent = false;

    geminiWs.on("open", () => {
        console.log("Gemini WS open, sending setup.");
        setupSent = true;

        const setupMsg = {
            setup: {
                model: liveModel,
                // Live API requires declaring your input audio format
                inputAudio: { format: "pcm16", sampleRateHertz: 16000 },
                generationConfig: {
                    responseModalities: ["AUDIO", "TEXT"],
                    temperature: 0.7
                },
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                }
            }
        };
        geminiWs.send(JSON.stringify(setupMsg));
    });

    geminiWs.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch {
            console.warn("Non-JSON Gemini frame received.");
            return;
        }

        if (msg.error) {
            console.error("Gemini error frame:", msg.error);
            return;
        }

        const parts = msg.serverContent?.modelTurn?.parts;
        if (Array.isArray(parts)) {
            for (const part of parts) {
                if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
                    const b64 = part.inlineData.data;
                    if (b64 && streamSid) {
                        const pcmBuf = base64ToBuffer(b64);
                        const int16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.length / 2);
                        const int16_8k = downsample16kTo8k(int16);
                        const mulawBuf = pcm16Int16ArrayToMuLawBuffer(int16_8k);
                        twilioWs.send(JSON.stringify({
                            event: "media",
                            streamSid,
                            media: { payload: bufferToBase64(mulawBuf) }
                        }));
                    }
                } else if (part.text) {
                    console.log("Gemini text:", part.text);
                }
            }
        }
    });

    geminiWs.on("close", (code, reason) => {
        console.log(`Gemini WS closed: ${code} ${reason || ""}`);
        if (!setupSent && code === 1006) {
            console.error("Handshake failure: verify endpoint, model name, and API key.");
        }
    });

    geminiWs.on("error", (err) => console.error("Gemini WS error:", err));

    twilioWs.on("message", (msg) => {
        let event;
        try { event = JSON.parse(msg.toString()); } catch {
            console.warn("Non-JSON Twilio frame received.");
            return;
        }

        switch (event.event) {
            case "start":
                streamSid = event.start.streamSid;
                console.log("Twilio stream start:", streamSid);
                break;
            case "media":
                if (geminiWs.readyState === WebSocket.OPEN) {
                    const muLawBuf = base64ToBuffer(event.media.payload);
                    const pcm16_8k = muLawBufferToPcm16Int16Array(muLawBuf);
                    const pcm16_16k = upsample8kTo16k(pcm16_8k);
                    const pcmBuf = Buffer.from(pcm16_16k.buffer);
                    const realtimeInput = {
                        realtimeInput: {
                            mediaChunks: [{
                                mimeType: "audio/pcm",
                                data: bufferToBase64(pcmBuf)
                            }]
                        }
                    };
                    geminiWs.send(JSON.stringify(realtimeInput));
                }
                break;
            case "stop":
                console.log("Twilio stream stopped.");
                if (geminiWs.readyState === WebSocket.OPEN) {
                    try { geminiWs.close(); } catch { }
                }
                break;
            default:
                break;
        }
    });

    twilioWs.on("close", () => {
        console.log("Twilio WS closed, closing Gemini WS.");
        if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    });

    twilioWs.on("error", (err) => console.error("Twilio WS error:", err));
});
// ...existing code...

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