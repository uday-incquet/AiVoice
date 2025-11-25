// Install dependencies:
// npm install express ws @google/genai twilio dotenv
// npm install -D @types/node

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality, MediaResolution } from '@google/genai';
import twilio from 'twilio';
import 'dotenv/config';

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const app = express();
const PORT = process.env.PORT || 5050;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-exp-1206-live';

const SYSTEM_MESSAGE = `You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested in and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.`;

if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY. Please set it in the .env file.');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.json({ message: 'Twilio Media Stream Server with Gemini Live API is running!' });
});

app.get('/token', (req, res) => {
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

app.all('/incoming-call', (req, res) => {
    const twimlResponse = new twilio.twiml.VoiceResponse();

    twimlResponse.say({
        voice: 'Google.en-US-Chirp3-HD-Aoede'
    }, 'Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Gemini Live API');

    twimlResponse.pause({ length: 1 });

    twimlResponse.say({
        voice: 'Google.en-US-Chirp3-HD-Aoede'
    }, 'O.K. you can start talking!');

    const connect = twimlResponse.connect();
    connect.stream({
        url: `wss://${req.headers.host}/media-stream`
    });

    res.type('text/xml');
    res.send(twimlResponse.toString());
});

const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', async (ws) => {
    console.log('Twilio client connected');

    let streamSid = null;
    let geminiSession = null;
    let sessionReady = false;
    const pendingAudio = [];

    try {
        console.log('Initializing Gemini session with model:', GEMINI_MODEL);
        const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

        const config = {
            responseModalities: [Modality.AUDIO],
            mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: {
                        voiceName: 'Zephyr',
                    },
                },
            },
            systemInstruction: {
                parts: [{ text: SYSTEM_MESSAGE }],
            },
        };

        geminiSession = await ai.live.connect({
            model: GEMINI_MODEL,
            config,
            callbacks: {
                onopen: () => {
                    console.log('Gemini session opened');
                    sessionReady = true;
                    flushPendingAudio();
                },
                onmessage: (message) => handleGeminiMessage(message),
                onerror: (e) => console.error('Gemini error:', e.message),
                onclose: (e) => {
                    console.log('Gemini session closed:', e.reason);
                    sessionReady = false;
                    if (ws.readyState === WebSocket.OPEN) {
                        console.log('Closing Twilio socket after Gemini close');
                        ws.close();
                    }
                },
            },
        });
    } catch (error) {
        console.error('Error initializing Gemini session:', error);
        ws.close();
        return;
    }

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw.toString());
            console.debug('Received Twilio event:', data.event);

            switch (data.event) {
                case 'start':
                    streamSid = data.start.streamSid;
                    console.log(`Incoming stream started: ${streamSid}`);
                    break;

                case 'media':
                    if (!geminiSession) return;
                    const payload = data.media.payload;
                    const chunk = convertMulawBase64ToPcm16Base64(payload);
                    console.debug('Converted audio chunk size (base64 chars):', chunk ? chunk.length : 'null', chunk);
                    if (!chunk) {
                        console.warn('Skipping empty chunk from Twilio');
                        return;
                    }

                    if (sessionReady) {
                        sendAudioChunkToGemini(chunk);
                    } else {
                        pendingAudio.push(chunk);
                        console.debug('Queued chunk; session not ready yet. Queue length:', pendingAudio.length);
                    }
                    break;

                case 'stop':
                    console.log('Stream stopped');
                    if (geminiSession) {
                        try {
                            console.log('Closing Gemini session after Twilio stop');
                            geminiSession.close();
                        } catch (err) {
                            console.error('Error closing Gemini session:', err);
                        }
                    }
                    break;

                default:
                    console.debug('Unhandled Twilio event type:', data.event);
                    break;
            }
        } catch (error) {
            console.error('Error processing Twilio message:', error);
        }
    });

    ws.on('close', () => {
        console.log('Twilio client disconnected');
        if (geminiSession) {
            try {
                console.log('Closing Gemini session after WS close');
                geminiSession.close();
            } catch (err) {
                console.error('Error closing Gemini session:', err);
            }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });

    function flushPendingAudio() {
        if (!pendingAudio.length) {
            console.debug('No pending audio to flush');
            return;
        }
        console.log(`Flushing ${pendingAudio.length} pending audio chunks to Gemini`);
        for (const chunk of pendingAudio) {
            sendAudioChunkToGemini(chunk);
        }
        pendingAudio.length = 0;
    }

    function sendAudioChunkToGemini(base64Pcm16) {
        if (!geminiSession || !sessionReady) {
            console.warn('Attempted to send audio before session ready');
            return;
        }

        console.debug('Sending audio chunk to Gemini. Size (base64 chars):', base64Pcm16.length);

        geminiSession.sendRealtimeInput({
            mediaChunks: [
                {
                    mimeType: 'audio/pcm;rate=16000',
                    data: base64Pcm16,
                },
            ],
        });
    }

    function handleGeminiMessage(message) {
        console.debug('Gemini message keys:', Object.keys(message));
        const parts = message.serverContent?.modelTurn?.parts;
        if (!Array.isArray(parts) || !streamSid) {
            console.debug('No modelTurn parts or missing streamSid');
            return;
        }

        for (const part of parts) {
            if (part.inlineData?.mimeType?.startsWith('audio/')) {
                const { mimeType, data } = part.inlineData;
                console.debug('Received audio part from Gemini. Mime:', mimeType);
                if (!data) {
                    console.warn('Audio part missing data payload');
                    continue;
                }

                const { muLawBase64, durationMs } = convertGeminiAudioToMulawBase64(data, mimeType);
                if (!muLawBase64) {
                    console.warn('Conversion to mu-law failed, skipping');
                    continue;
                }

                const audioMessage = {
                    event: 'media',
                    streamSid,
                    media: { payload: muLawBase64 },
                };

                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(audioMessage));
                    console.log(`Sent ${durationMs} ms of Gemini audio back to Twilio`);
                } else {
                    console.warn('Twilio socket closed; cannot send audio');
                }
            } else if (part.text) {
                console.log('Gemini text part:', part.text);
            } else {
                console.debug('Unhandled part type:', part);
            }
        }
    }
});

function convertMulawBase64ToPcm16Base64(mulawBase64) {
    try {
        const muLawBuffer = Buffer.from(mulawBase64, 'base64');
        console.debug('Decoded mu-law buffer length:', muLawBuffer.length);
        const pcm16_8k = muLawBufferToPcm16Int16Array(muLawBuffer);
        const pcm16_16k = upsample8kTo16k(pcm16_8k);
        const pcmBuffer = Buffer.from(
            pcm16_16k.buffer,
            pcm16_16k.byteOffset,
            pcm16_16k.byteLength
        );
        return pcmBuffer.toString('base64');
    } catch (err) {
        console.error('Error converting mu-law to PCM16:', err);
        return null;
    }
}

function convertGeminiAudioToMulawBase64(base64Pcm, mimeType) {
    try {
        const pcmBuffer = Buffer.from(base64Pcm, 'base64');
        console.debug('Gemini PCM buffer length:', pcmBuffer.length);
        let sampleRate = 16000;
        const rateMatch = mimeType.match(/rate=(\d+)/);
        if (rateMatch) {
            sampleRate = parseInt(rateMatch[1], 10);
        }
        console.debug('Gemini audio sample rate:', sampleRate);

        let int16 = new Int16Array(
            pcmBuffer.buffer,
            pcmBuffer.byteOffset,
            pcmBuffer.length / 2
        );

        if (sampleRate === 24000) {
            console.debug('Downsampling 24kHz -> 16kHz');
            int16 = downsample(int16, sampleRate, 16000);
            sampleRate = 16000;
        } else if (sampleRate !== 16000) {
            console.debug(`Downsampling ${sampleRate}Hz -> 16000Hz`);
            int16 = downsample(int16, sampleRate, 16000);
            sampleRate = 16000;
        }

        const pcm16_8k = downsample16kTo8k(int16);
        console.debug('PCM 8k sample count:', pcm16_8k.length);
        const muLawBuffer = pcm16Int16ArrayToMuLawBuffer(pcm16_8k);
        return {
            muLawBase64: muLawBuffer.toString('base64'),
            durationMs: Math.round((pcm16_8k.length / 8000) * 1000),
        };
    } catch (err) {
        console.error('Error converting Gemini audio:', err);
        return { muLawBase64: null, durationMs: 0 };
    }
}

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

function mulawDecodeByte(mu) {
    mu = mu ^ 0xff;
    const sign = (mu & 0x80) ? -1 : 1;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
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

    const mantissa = (pcmVal >> (exponent + 3)) & 0x0f;
    const mu = ~(sign | (exponent << 4) | mantissa) & 0xff;
    return mu;
}

function upsample8kTo16k(int16Arr8k) {
    if (!int16Arr8k.length) return new Int16Array();
    const out = new Int16Array(int16Arr8k.length * 2);
    for (let i = 0; i < int16Arr8k.length - 1; i++) {
        const s0 = int16Arr8k[i];
        const s1 = int16Arr8k[i + 1];
        out[2 * i] = s0;
        out[2 * i + 1] = Math.round((s0 + s1) / 2);
    }
    const last = int16Arr8k[int16Arr8k.length - 1];
    out[out.length - 2] = last;
    out[out.length - 1] = last;
    return out;
}

function downsample16kTo8k(int16Arr16k) {
    if (!int16Arr16k.length) return new Int16Array();
    const out = new Int16Array(Math.floor(int16Arr16k.length / 2));
    for (let i = 0, j = 0; j < out.length; i += 2, j++) {
        out[j] = int16Arr16k[i];
    }
    return out;
}

function downsample(source, fromRate, toRate) {
    if (fromRate === toRate) return source;
    const ratio = fromRate / toRate;
    const newLength = Math.floor(source.length / ratio);
    const result = new Int16Array(newLength);
    for (let i = 0; i < newLength; i++) {
        result[i] = source[Math.floor(i * ratio)];
    }
    return result;
}

console.log(`Server starting on port ${PORT}...`);