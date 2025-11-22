

// backend/routes/voice.js - Webhook endpoints
import express from 'express';
import twilio from 'twilio';

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

router.post('/outgoing', (req, res) => {
    const twiml = new VoiceResponse();
    const twilioNumber = '+12176018762';
    console.log('body ====>', req.body)
    console.log("From:", req.body.From, " ", req.body.From.startsWith('client'));
    if (!req.body.callDirection || req.body.callDirection !== 'outgoing') {

        console.log('Handling inbound call from:', req.body.From);
        const twiml = new VoiceResponse();

        const dial = twiml.dial();
        dial.client('user123');

        res.type('text/xml');
        res.send(twiml.toString());
        return;
    } else {
        console.log('Handling outbound call to:', req.body.To);
        const phoneNumber = req.body.To;
        if (phoneNumber && phoneNumber !== twilioNumber) {
            console.log('Making outbound call to:', phoneNumber);

            const dial = twiml.dial({
                callerId: twilioNumber,
                answerOnBridge: true,
                timeout: 30,
                statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            });
            dial.number(phoneNumber);
        } else {
            console.log('No valid outbound number or calling self');
            // Return empty response like Python version
            res.type('text/xml');
            res.send('');
            return;
        }

        console.log('Generated TwiML:', twiml.toString());
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

// Handle incoming calls
router.post('/', (req, res) => {
    const twiml = new VoiceResponse();

    const dial = twiml.dial();
    dial.client('user123');

    res.type('text/xml');
    res.send(twiml.toString());
});

// router.post('/outgoing', (req, res) => {
//     console.log('=== VOICE WEBHOOK TRIGGERED ===');
//     console.log('Request body:', req.body);

//     const twiml = new VoiceResponse();

//     // Check if this is an outgoing call (when you use device.connect())
//     // Outgoing calls will have 'To' parameter with the phone number you're calling
//     if (req.body.To && req.body.To.startsWith('+')) {
//         console.log('=== OUTGOING CALL ===');
//         const phoneNumber = req.body.To;
//         const twilioNumber = process.env.TWILIO_NUMBER;

//         console.log('Calling number:', phoneNumber);
//         console.log('From Twilio number:', twilioNumber);

//         if (phoneNumber !== twilioNumber) {
//             const dial = twiml.dial({
//                 callerId: twilioNumber,
//                 timeout: 30
//             });
//             dial.number(phoneNumber);
//         } else {
//             res.type('text/xml');
//             res.send('');
//             return;
//         }
//     }
//     // This is an incoming call (someone calling your Twilio number)
//     else {
//         console.log('=== INCOMING CALL ===');
//         console.log('From:', req.body.From);

//         const dial = twiml.dial({
//             timeout: 30
//         });

//         // Route incoming calls to your browser client
//         dial.client('user123'); // This should match your token identity
//     }

//     console.log('Generated TwiML:', twiml.toString());
//     res.type('text/xml');
//     res.send(twiml.toString());
// });

export default router;