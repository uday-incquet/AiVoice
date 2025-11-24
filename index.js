// Install dependencies:
// npm install express ws @google/genai twilio dotenv
// npm install -D @types/node

import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, MediaResolution } from '@google/genai';
import twilio from 'twilio';
import { jwt } from 'twilio';
const AccessToken = jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 5050;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SYSTEM_MESSAGE = `You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested in and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.`;

if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY. Please set it in the .env file.');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root endpoint
app.get('/', (req, res) => {
    res.json({ message: 'Twilio Media Stream Server with Gemini Live API is running!' });
});

// Token endpoint for Twilio Voice SDK
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

// Incoming call endpoint
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

// Start HTTP server
const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// WebSocket server for Twilio Media Streams
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', async (ws) => {
    console.log('Client connected');

    let streamSid = null;
    let geminiSession = null;
    const responseQueue = [];
    const audioParts = [];

    try {
        // Initialize Gemini AI
        const ai = new GoogleGenAI({
            apiKey: GEMINI_API_KEY,
        });

        const model = process.env.GEMINI_MODEL || 'models/gemini-2.5-flash-native-audio-preview-09-2025';

        const config = {
            responseModalities: [Modality.AUDIO],
            mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: {
                        voiceName: 'Zephyr',
                    }
                }
            }
        };

        // Connect to Gemini Live API
        geminiSession = await ai.live.connect({
            model,
            callbacks: {
                onopen: () => {
                    console.log('Gemini session opened');
                },
                onmessage: (message) => {
                    responseQueue.push(message);
                    handleGeminiMessage(message);
                },
                onerror: (e) => {
                    console.error('Gemini error:', e.message);
                },
                onclose: (e) => {
                    console.log('Gemini session closed:', e.reason);
                },
            },
            config
        });

        // Send initial system message
        geminiSession.sendClientContent({
            turns: [SYSTEM_MESSAGE]
        });

        // Handle messages from Twilio
        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message);

                if (data.event === 'start') {
                    streamSid = data.start.streamSid;
                    console.log(`Incoming stream started: ${streamSid}`);
                }

                if (data.event === 'media') {
                    // Convert Twilio's mulaw audio to base64 and send to Gemini
                    const audioData = data.media.payload;

                    // Send audio to Gemini
                    if (geminiSession) {
                        geminiSession.sendClientContent({
                            turns: [{
                                role: 'user',
                                parts: [{
                                    inlineData: {
                                        mimeType: 'audio/pcm;rate=8000',
                                        data: convertMulawToPcm(audioData)
                                    }
                                }]
                            }]
                        });
                    }
                }

                if (data.event === 'stop') {
                    console.log('Stream stopped');
                }
            } catch (error) {
                console.error('Error processing Twilio message:', error);
            }
        });

        // Handle Gemini responses
        function handleGeminiMessage(message) {
            if (message.serverContent?.modelTurn?.parts) {
                const part = message.serverContent.modelTurn.parts[0];

                if (part?.inlineData) {
                    const inlineData = part.inlineData;

                    // Convert Gemini audio to Twilio's mulaw format
                    try {
                        const pcmData = inlineData.data;
                        const mulawData = convertPcmToMulaw(pcmData);

                        // Send audio back to Twilio
                        const audioMessage = {
                            event: 'media',
                            streamSid: streamSid,
                            media: {
                                payload: mulawData
                            }
                        };

                        if (ws.readyState === ws.OPEN) {
                            ws.send(JSON.stringify(audioMessage));
                        }
                    } catch (error) {
                        console.error('Error processing audio:', error);
                    }
                }

                if (part?.text) {
                    console.log('Gemini text response:', part.text);
                }
            }
        }

        ws.on('close', () => {
            console.log('Client disconnected');
            if (geminiSession) {
                geminiSession.close();
            }
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });

    } catch (error) {
        console.error('Error initializing Gemini session:', error);
        ws.close();
    }
});

// Audio conversion functions
function convertMulawToPcm(mulawBase64) {
    // Decode mulaw audio from Twilio to PCM
    const mulawBuffer = Buffer.from(mulawBase64, 'base64');
    const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2);

    for (let i = 0; i < mulawBuffer.length; i++) {
        const mulaw = mulawBuffer[i];
        const pcm = mulawToPcm(mulaw);
        pcmBuffer.writeInt16LE(pcm, i * 2);
    }

    return pcmBuffer.toString('base64');
}

function convertPcmToMulaw(pcmBase64) {
    // Convert PCM from Gemini to mulaw for Twilio
    const pcmBuffer = Buffer.from(pcmBase64, 'base64');
    const mulawBuffer = Buffer.alloc(pcmBuffer.length / 2);

    for (let i = 0; i < mulawBuffer.length; i++) {
        const pcm = pcmBuffer.readInt16LE(i * 2);
        const mulaw = pcmToMulaw(pcm);
        mulawBuffer[i] = mulaw;
    }

    return mulawBuffer.toString('base64');
}

// Mulaw encoding/decoding algorithms
function mulawToPcm(mulaw) {
    mulaw = ~mulaw;
    const sign = (mulaw & 0x80) ? -1 : 1;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    return sign * (sample - 0x84);
}

function pcmToMulaw(pcm) {
    const sign = pcm < 0 ? 0x80 : 0x00;
    pcm = Math.abs(pcm);
    pcm += 0x84;

    if (pcm > 0x7FFF) pcm = 0x7FFF;

    let exponent = 7;
    for (let exp = 0; exp < 8; exp++) {
        if (pcm <= (0x84 << exp)) {
            exponent = exp;
            break;
        }
    }

    const mantissa = (pcm >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa);
}

console.log(`Server starting on port ${PORT}...`);