// server.js (ES module style)
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "dotenv";
import xmlbuilder2 from "xmlbuilder2";
const { xml } = xmlbuilder2;
import twilio from "twilio";
import cors from "cors";

config();

const PORT = process.env.PORT || 5050;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash-native-audio-preview-09-2025";
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

if (!GEMINI_KEY) {
    throw new Error("Missing GEMINI_API_KEY in .env");
}

const app = express();
app.use(cors())
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => res.json({ message: "Twilio + Gemini Live API bridge running" }));

app.get("/token", (req, res) => {
    try {
        console.log(process.env.TWILIO_ACCOUNT_SID);
        console.log('Generating token for accountSid:', process.env.TWILIO_ACCOUNT_SID);
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

        res.json({
            token: jwt,
            identity: 'user123'
        });
    } catch (error) {
        console.error('Error generating token:', error);
        res.status(500).json({ error: 'Failed to generate token' });
    }
})

app.post("/incoming-call", (req, res) => {
    const host = req.headers.host;
    const twiml = xml({
        Response: {
            Say: [
                {
                    "@voice": "Google.en-US-Chirp3-HD-Aoede",
                    "#": "Please wait while we connect you to the Gemini voice assistant."
                }
            ],
            Pause: { "@length": 1 },
            Say: {
                "@voice": "Google.en-US-Chirp3-HD-Aoede",
                "#": "Okay — you can start talking now!"
            },
            Connect: { Stream: { "@url": `wss:// https://aivoice-o1it.onrender.com/media-stream` } }
        }
    }).end({ prettyPrint: true });

    res.type("text/xml").send(twiml);
});

/* -------------------------
   Audio codec + utility funcs
   - Twilio Media Streams => PCMU (μ-law) @ 8 kHz (common default)
   - Gemini Live API expects PCM16 @ 16 kHz (we upsample/resample)
-------------------------*/

// μ-law (G.711 a-law/μ-law) constants & helper logic
function mulawDecodeByte(mu) {
    // mu is unsigned byte 0..255
    mu = mu ^ 0xFF;
    const sign = (mu & 0x80) ? -1 : 1;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample = sign * (sample - 0x84);
    // clip to int16
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    return sample;
}

function mulawEncodeSample(sample) {
    // sample: signed 16-bit integer
    const MU_BIAS = 33;
    let sign = 0;
    let pcmVal = sample;

    if (pcmVal < 0) {
        pcmVal = -pcmVal;
        sign = 0x80;
    }
    if (pcmVal > 32635) pcmVal = 32635;

    pcmVal += MU_BIAS;

    // find exponent
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

// Convert Buffer of μ-law bytes -> Int16Array (PCM16)
function muLawBufferToPcm16Int16Array(muBuf) {
    const out = new Int16Array(muBuf.length);
    for (let i = 0; i < muBuf.length; i++) {
        out[i] = mulawDecodeByte(muBuf[i]);
    }
    return out;
}

// Convert Int16Array -> Buffer of μ-law bytes
function pcm16Int16ArrayToMuLawBuffer(int16Arr) {
    const out = Buffer.alloc(int16Arr.length);
    for (let i = 0; i < int16Arr.length; i++) {
        out[i] = mulawEncodeSample(int16Arr[i]);
    }
    return out;
}

/* -------------------------
   Simple resampler: 8k <-> 16k
   - Upsample 8k -> 16k: linear interpolation (insert one sample between each pair)
   - Downsample 16k -> 8k: take every 2nd sample (simple decimation)
   * These are lightweight and reasonable for voice; replace with a proper resampler if high fidelity needed.
-------------------------*/

function upsample8kTo16k(int16Arr8k) {
    const out = new Int16Array(int16Arr8k.length * 2);
    for (let i = 0; i < int16Arr8k.length - 1; i++) {
        const s0 = int16Arr8k[i];
        const s1 = int16Arr8k[i + 1];
        out[2 * i] = s0;
        // linear interpolation
        out[2 * i + 1] = Math.round((s0 + s1) / 2);
    }
    // last sample copy
    out[out.length - 2] = int16Arr8k[int16Arr8k.length - 1];
    out[out.length - 1] = int16Arr8k[int16Arr8k.length - 1];
    return out;
}

function downsample16kTo8k(int16Arr16k) {
    // pick every 2nd sample (simple decimation)
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

    // Gemini Live API websocket endpoint (gives a generic endpoint - this is the typical GA/preview path)
    // NOTE: If your provider requires a different host/path, update accordingly.
    const geminiEndpoint = "wss://generativelanguage.googleapis.com/v1beta/realtime";

    const geminiWs = new WebSocket(`${geminiEndpoint}`, {
        headers: {
            Authorization: `Bearer ${GEMINI_KEY}`
        }
    });

    let streamSid = null;
    let geminiReady = false;

    geminiWs.on("open", () => {
        console.log("Connected to Gemini Live API websocket.");
        // Send setup frame expected by Gemini Live API
        const setup = {
            setup: {
                model: GEMINI_MODEL,
                audioConfig: {
                    voiceConfig: {}, // default voice
                    inputAudio: {
                        encoding: "pcm16",
                        sampleRateHertz: 16000
                    },
                    outputAudio: {
                        encoding: "pcm16",
                        sampleRateHertz: 16000
                    }
                }
            }
        };
        geminiWs.send(JSON.stringify(setup));
        geminiReady = true;
    });

    geminiWs.on("message", (raw) => {
        // Gemini messages are JSON with output.audio.data base64 for audio frames
        try {
            const msg = JSON.parse(raw.toString());
            // handle output audio frames
            // some APIs use msg.output.audio.data or msg.output?.audio?.data
            const b64 = msg?.output?.audio?.data || msg?.output?.audioData || msg?.audio?.data;
            if (b64 && streamSid) {
                // decode base64 to PCM16 Int16Array
                const pcmBuf = base64ToBuffer(b64);
                // Buffer -> Int16Array little-endian
                const int16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.length / 2));
                // If endianness mismatch / Buffer view issues, convert explicitly:
                // but Node Buffer is little-endian, as is our assumption.

                // Downsample 16k -> 8k for Twilio PCMU default
                const int16_8k = downsample16kTo8k(int16);

                // convert to μ-law bytes
                const mulawBuf = pcm16Int16ArrayToMuLawBuffer(int16_8k);

                const audioDelta = {
                    event: "media",
                    streamSid,
                    media: { payload: bufferToBase64(mulawBuf) }
                };
                // send to Twilio
                try {
                    twilioWs.send(JSON.stringify(audioDelta));
                } catch (e) {
                    console.error("Error sending audio to Twilio:", e);
                }
            } else {
                // log other types for debugging
                if (msg && msg.type) {
                    console.log("Gemini event:", msg.type);
                }
            }
        } catch (e) {
            console.warn("Non-JSON message or parse error from Gemini:", e);
        }
    });

    geminiWs.on("close", () => console.log("Gemini WS closed."));
    geminiWs.on("error", (err) => console.error("Gemini WS error:", err));

    twilioWs.on("message", (msg) => {
        try {
            const event = JSON.parse(msg.toString());
            if (event.event === "start") {
                streamSid = event.start.streamSid;
                console.log("Twilio stream start:", streamSid);
            } else if (event.event === "media") {
                // Twilio sends μ-law base64 payload
                const muLawBase64 = event.media.payload;
                const muLawBuf = base64ToBuffer(muLawBase64);

                // μ-law -> PCM16 int16 array @ 8 kHz
                const pcm16_8k = muLawBufferToPcm16Int16Array(muLawBuf);

                // Upsample 8k -> 16k
                const pcm16_16k = upsample8kTo16k(pcm16_8k);

                // Convert Int16Array -> Buffer (little endian)
                const pcmBuf = Buffer.from(pcm16_16k.buffer);

                // Gemini Live wants base64 PCM16 in a JSON frame like {inputAudio:{data: "<base64>"}}
                if (geminiReady && geminiWs.readyState === WebSocket.OPEN) {
                    const frame = {
                        inputAudio: { data: bufferToBase64(pcmBuf) }
                    };
                    geminiWs.send(JSON.stringify(frame));
                }
            } else if (event.event === "stop") {
                console.log("Twilio stream stopped.");
                // send an end-of-input or similar to Gemini if supported
                if (geminiWs.readyState === WebSocket.OPEN) {
                    // Some Gemini Live APIs expect a specific end signal; use "inputAudio.end" or session end if docs say so:
                    // We'll send a generic 'input_audio_end' custom frame (if your Gemini variant expects something else, adapt).
                    try {
                        geminiWs.send(JSON.stringify({ inputAudio: { done: true } }));
                    } catch (e) { }
                }
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

/* HTTP -> WS upgrade */
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
