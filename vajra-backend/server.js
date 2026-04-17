require('dotenv').config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { getDistance } = require("geolib");
const twilio = require("twilio");

const app = express();
app.use(cors());
app.use(express.json());

// Serve Static Frontend Files
const frontendPath = path.join(__dirname, "../frontend");
app.use(express.static(frontendPath));

// Configuration Endpoint for Frontend (Google Maps Key)
app.get("/config", (req, res) => {
    res.json({
        googleMapsKey: process.env.GOOGLE_MAPS_API_KEY
    });
});

// Dashboard Root Route
app.get("/", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
});

// Request logging for debugging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// Twilio, n8n & Google Config
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;
const googleMapsKey = process.env.GOOGLE_MAPS_API_KEY;
const client = new twilio(accountSid, authToken);

// Session Persistence Layer
const DB_FILE = path.join(__dirname, "sessions.json");
let sessions = {};

function saveSessions() {
    fs.writeFileSync(DB_FILE, JSON.stringify(sessions, null, 2));
}

function loadSessions() {
    if (fs.existsSync(DB_FILE)) {
        try {
            sessions = JSON.parse(fs.readFileSync(DB_FILE));
            console.log("Sessions loaded from disk.");
        } catch (e) {
            console.error("Failed to load sessions:", e);
        }
    }
}
loadSessions();

// Helper: Distance to Polyline (Nearest Point)
function getDistanceToRoute(point, route) {
    if (!route || route.length === 0) return 0;
    let minDistance = Infinity;
    route.forEach(routePoint => {
        const dist = getDistance(
            { latitude: point.lat, longitude: point.lng },
            { latitude: routePoint.lat, longitude: routePoint.lng }
        );
        if (dist < minDistance) minDistance = dist;
    });
    return minDistance;
}

// =======================
// CREATE SESSION
// =======================
app.post("/create", (req, res) => {
    const { destination, phone, expectedRoute } = req.body;
    const id = Date.now().toString();

    // If no route provided, create a mock one for demo
    const mockRoute = expectedRoute || [
        { lat: 19.0760, lng: 72.8777 },
        { lat: 19.0800, lng: 72.8850 },
        { lat: 19.0850, lng: 72.8950 }
    ];

    sessions[id] = {
        id,
        destination: destination || "Unknown",
        phone,
        status: "WAITING",
        currentLocation: null,
        pathHistory: [],
        expectedRoute: mockRoute,
        lastPing: Date.now(),
        deviationCount: 0,
        alert: null,
        sosTriggered: false,
        alertsSent: false
    };

    saveSessions();

    const protocol = req.protocol;
    const host = req.get("host");

    res.json({
        sessionId: id,
        trackingLink: `${protocol}://${host}/#${id}`
    });
});

// =======================
// UPDATE LOCATION
// =======================
app.post("/location", async (req, res) => {
    const { sessionId, lat, lng } = req.body;
    const session = sessions[sessionId];

    if (!session) return res.status(404).json({ error: "Session not found" });

    const newPoint = { lat, lng };
    session.currentLocation = newPoint;
    session.pathHistory.push(newPoint);
    session.lastPing = Date.now();

    // Calculate Deviation
    const distanceToRoute = getDistanceToRoute(newPoint, session.expectedRoute);
    
    if (distanceToRoute > 500) {
        session.deviationCount += 1;
        if (session.deviationCount >= 3) {
            session.status = "RISK";
            session.alert = "Route deviation detected!";
            triggerSOS(session);
        }
    } else {
        session.deviationCount = 0;
        if (session.status !== "RISK") session.status = "ACTIVE";
    }

    saveSessions();
    res.json({ success: true, status: session.status });
});

// =======================
// MANUAL SOS / ESCALATION
// =======================
app.get("/sos", (req, res) => {
    res.send(`<h1>VAJRA SOS System</h1><p>Manual trigger active.</p>`);
});

app.post("/sos", async (req, res) => {
    const { sessionId, escalatedByContact } = req.body;
    const session = sessions[sessionId];

    if (!session) return res.status(404).json({ error: "Session not found" });

    session.sosTriggered = true;
    session.status = "RISK";
    session.alert = escalatedByContact ? "MANUAL ESCALATION BY CONTACT" : "Manual SOS triggered!";
    
    triggerSOS(session);
    saveSessions();
    res.json({ success: true });
});

async function triggerSOS(session) {
    if (session.alertsSent) return;
    session.alertsSent = true;

    const trackingLink = `http://localhost:8001/#${session.id}`; // Local Link (Will be dynamic in production)
    const message = `🚨 VAJRA SOS ALERT: ${session.alert}. Live tracking: ${trackingLink}`;

    try {
        // 1. Notify n8n (for Telegram/WhatsApp)
        await fetch(n8nWebhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                event: "VAJRA_SOS_ALERT",
                sessionId: session.id,
                reason: session.alert,
                trackingLink: trackingLink,
                location: session.currentLocation
            })
        });
        console.log(`n8n Webhook notified for Session: ${session.id}`);

        // 2. Send SMS via Twilio
        await client.messages.create({
            body: message,
            from: twilioNumber,
            to: session.phone
        });

        // 3. Make Call via Twilio
        await client.calls.create({
            url: "http://demo.twilio.com/docs/voice.xml",
            from: twilioNumber,
            to: session.phone
        });

        console.log(`SOS Alerts sent to ${session.phone}`);
    } catch (err) {
        console.error("SOS Trigger Error:", err.message);
    }
}

// =======================
// GET TRACK DATA
// =======================
app.get("/track/:id", (req, res) => {
    const session = sessions[req.params.id];
    if (!session) return res.status(404).json({ error: `Session ${req.params.id} not found` });
    res.json(session);
});

// =======================
// DEAD-MAN SWITCH
// =======================
setInterval(() => {
    const now = Date.now();
    let updated = false;
    Object.values(sessions).forEach(session => {
        if (now - session.lastPing > 180000 && session.status !== "NO_SIGNAL" && session.status !== "RISK") {
            session.status = "NO_SIGNAL";
            session.alert = "User unreachable (Signal Lost)";
            updated = true;
        }
    });
    if (updated) saveSessions();
}, 60000);

// =======================
app.listen(8001, () => {
    console.log("Server running on port 8001");
});