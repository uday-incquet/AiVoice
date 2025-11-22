import express from 'express';
import twilio from 'twilio';

const router = express.Router();

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;


router.get('/', (req, res) => {
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
});

export default router;