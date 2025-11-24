import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "dotenv";
import twilio from "twilio";
import cors from "cors";

config();

const PORT = process.env.PORT || 5050;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.0-flash-exp";

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
    connect.stream({ url: "wss://aivoice-o1it.onrender.com/media-stream" });
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

    const geminiWsUrl = `wss://generativelanguage.googleapis.com/v1alpha/${GEMINI_MODEL}:bidiConnect?key=${GEMINI_KEY}`;

    const geminiWs = new WebSocket(geminiWsUrl);

    let streamSid = null;

    geminiWs.on("open", () => {
        console.log("Connected to Gemini Live API.");
        const setupMsg = {
            setup: {
                model: GEMINI_MODEL,
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                    }
                }
            }
        };
        geminiWs.send(JSON.stringify(setupMsg));
    });

    geminiWs.on("message", (raw) => {
        try {
            const msg = JSON.parse(raw.toString());

            if (msg.serverContent?.modelTurn?.parts) {
                for (const part of msg.serverContent.modelTurn.parts) {
                    if (part.inlineData && part.inlineData.mimeType.startsWith("audio/pcm")) {
                        const b64 = part.inlineData.data;
                        if (b64 && streamSid) {
                            const pcmBuf = base64ToBuffer(b64);
                            const int16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.length / 2));
                            const int16_8k = downsample16kTo8k(int16);
                            const mulawBuf = pcm16Int16ArrayToMuLawBuffer(int16_8k);

                            const audioDelta = {
                                event: "media",
                                streamSid,
                                media: { payload: bufferToBase64(mulawBuf) }
                            };
                            twilioWs.send(JSON.stringify(audioDelta));
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Error processing Gemini message:", e);
        }
    });

    geminiWs.on("close", (code, reason) => console.log(`Gemini WS closed: ${code} ${reason}`));
    geminiWs.on("error", (err) => console.error("Gemini WS error:", err));

    twilioWs.on("message", (msg) => {
        try {
            const event = JSON.parse(msg.toString());
            if (event.event === "start") {
                streamSid = event.start.streamSid;
                console.log("Twilio stream start:", streamSid);
            } else if (event.event === "media") {
                const muLawBuf = base64ToBuffer(event.media.payload);
                const pcm16_8k = muLawBufferToPcm16Int16Array(muLawBuf);
                const pcm16_16k = upsample8kTo16k(pcm16_8k);
                const pcmBuf = Buffer.from(pcm16_16k.buffer);

                if (geminiWs.readyState === WebSocket.OPEN) {
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
            } else if (event.event === "stop") {
                console.log("Twilio stream stopped.");
                if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
            }
        } catch (e) {
            console.error("Error processing Twilio message:", e);
        }
    });

    twilioWs.on("close", () => {
        console.log("Twilio WS closed, closing Gemini WS.");
        if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    });

    twilioWs.on("error", (err) => console.error("Twilio WS error:", err));
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