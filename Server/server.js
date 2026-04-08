require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// --- MongoDB Setup ---
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/motor_data8c";
mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error('MongoDB connection error:', err));

// Device Schema
const DeviceSchema = new mongoose.Schema({
    macAddress: { type: String, unique: true },
    serialNumber: String,
    ownerEmail: String,
    alias: String,
    createdAt: { type: Date, default: Date.now }
});
const DeviceModel = mongoose.model('Device8c', DeviceSchema);

// Updated Schema
const LogSchema = new mongoose.Schema({
    macAddress: String,
    startTime: Date,
    endTime: Date,
    duration: String,
    bdDate: String,
    bdTime: String,
    createdAt: { type: Date, default: Date.now }
});
const MotorLog = mongoose.model('MotorLog46', LogSchema);

const ScheduleSchema = new mongoose.Schema({
    macAddress: String,
    type: { type: String, enum: ['DAILY', 'WEEKLY', 'DATE_RANGE'], required: true },
    isActive: { type: Boolean, default: true },
    startTime: String, // HH:MM like "08:00"
    endTime: String, // HH:MM like "10:30"
    daysOfWeek: [Number], // 0=Sun, 1=Mon...
    startDate: Date,
    endDate: Date,
    createdAt: { type: Date, default: Date.now }
});
const MotorSchedule = mongoose.model('MotorSchedule8c', ScheduleSchema);

const SettingsSchema = new mongoose.Schema({
    macAddress: { type: String, unique: true },
    isAlwaysOn: { type: Boolean, default: false }
});
const SystemSettings = mongoose.model('SystemSettings8c', SettingsSchema);

const cors = require('cors');
app.use(cors());
app.use(express.static(path.join(__dirname, '../Dashboard')));
app.use(express.json());

// Multi-Device API Routes
app.post('/api/devices', async (req, res) => {
    const { macAddress, serialNumber, ownerEmail, alias } = req.body;
    if(!macAddress || !ownerEmail) return res.status(400).send("macAddress and ownerEmail required");
    try {
        let dev = await DeviceModel.findOne({ macAddress });
        if(dev) {
            dev.ownerEmail = ownerEmail;
            if(serialNumber) dev.serialNumber = serialNumber;
            if(alias) dev.alias = alias;
            await dev.save();
        } else {
            dev = new DeviceModel({ macAddress, serialNumber, ownerEmail, alias });
            await dev.save();
        }
        res.json(dev);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/devices', async (req, res) => {
    const { email } = req.query;
    if(!email) return res.status(400).send("email query required");
    try {
        const devs = await DeviceModel.find({ ownerEmail: email });
        res.json(devs);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/status', (req, res) => {
    res.send('server is running');
});

// Serve index.html but dynamically configured by client passing ?mac=
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../Dashboard', 'index.html'));
});

const wss = new WebSocket.Server({ server });

const esp32Clients = new Map(); // macAddress -> ws
const webClients = new Set(); // We will store ws.macAddress to route commands

// --- Motor State Tracking (Per Device) ---
const deviceStates = new Map(); // mac -> { motorStartTime, lastMotorStatus, alwaysOn }

const FALLBACK_MAC = "68:FE:71:8A:85:30"; // Support existing clients without MAC

async function getDeviceState(mac) {
    if (!deviceStates.has(mac)) {
        let alwaysOn = false;
        try {
            const doc = await SystemSettings.findOne({ macAddress: mac });
            if (doc) alwaysOn = doc.isAlwaysOn;
            else await new SystemSettings({ macAddress: mac }).save();
        } catch(e) {}
        deviceStates.set(mac, { motorStartTime: null, lastMotorStatus: 'OFF', alwaysOn });
    }
    return deviceStates.get(mac);
}

// Function to broadcast to a specific device's web clients
function broadcastToWebClients(mac, payloadStr) {
    webClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.macAddress === mac) {
            client.send(payloadStr);
        }
    });
}

wss.on('connection', (ws) => {
    console.log('A client connected. Waiting for identification...');
    ws.isIdentified = false;

    // Timeout: Default to old web client using FALLBACK_MAC
    const identificationTimeout = setTimeout(() => {
        if (!ws.isIdentified) {
            console.log('Client did not identify. Assuming legacy web client.');
            webClients.add(ws);
            ws.isIdentified = true;
            ws.macAddress = FALLBACK_MAC; // Bind to default

            const targetEsp = esp32Clients.get(ws.macAddress);
            const espStatus = (targetEsp && targetEsp.readyState === WebSocket.OPEN) ? 'online' : 'offline';
            ws.send(JSON.stringify({ type: 'espStatus', status: espStatus }));
            
            getDeviceState(ws.macAddress).then(state => {
                 ws.send(JSON.stringify({
                    type: 'statusUpdate',
                    payload: {
                       lastAction: "Server connected", 
                       motorStatus: state.lastMotorStatus,
                       systemMode: "Normal"
                    }
                 }));
            });
        }
    }, 2000);

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return;
        }

        if (data.type === 'esp32-identify' && !ws.isIdentified) {
            clearTimeout(identificationTimeout);
            const clientMac = data.macAddress || FALLBACK_MAC; // Legacy devices don't send mac
            console.log(`ESP32 client identified as ${clientMac}`);
            
            ws.macAddress = clientMac;
            esp32Clients.set(clientMac, ws);
            ws.isIdentified = true;
            
            broadcastToWebClients(clientMac, JSON.stringify({ type: 'espStatus', status: 'online' }));

            // Initial Always ON Trigger
            const state = await getDeviceState(clientMac);
            if (state.alwaysOn) {
                console.log(`Always ON Enforcer: Triggering Motor ON for ${clientMac} upon connection.`);
                ws.send('{"command":"RELAY_1_ALWAYS"}');
            }

        } else if (data.type === 'web-identify' && !ws.isIdentified) {
            clearTimeout(identificationTimeout);
            const targetMac = data.macAddress || FALLBACK_MAC;
            console.log(`Web client identified explicitly for device ${targetMac}`);
            
            ws.macAddress = targetMac;
            webClients.add(ws);
            ws.isIdentified = true;

            const targetEsp = esp32Clients.get(targetMac);
            const espStatus = (targetEsp && targetEsp.readyState === WebSocket.OPEN) ? 'online' : 'offline';
            ws.send(JSON.stringify({ type: 'espStatus', status: espStatus }));
            
            const state = await getDeviceState(targetMac);
            ws.send(JSON.stringify({
                type: 'statusUpdate',
                payload: {
                   lastAction: "Server connected", 
                   motorStatus: state.lastMotorStatus,
                   systemMode: "Normal"
                }
            }));

        } else if (data.type === 'command' && ws.isIdentified && !esp32Clients.has(ws.macAddress)) {
            // IF WS IS NOT AN ESP32 BUT A WEB CLIENT (or we handle it via webClients set)
            if (webClients.has(ws)) {
                const targetMac = ws.macAddress;
                
                if (data.command === 'GET_LOG_PAGE') {
                    const page = data.value || 0;
                    const limit = 10;
                    let query = { macAddress: targetMac };
                    
                    if (data.startDate && data.endDate) {
                        const start = new Date(data.startDate); start.setHours(0,0,0,0);
                        const end = new Date(data.endDate); end.setHours(23,59,59,999);
                        query.startTime = { $gte: start, $lte: end };
                    }

                    try {
                        const totalLogs = await MotorLog.countDocuments(query);
                        const totalPages = Math.ceil(totalLogs / limit);
                        const logs = await MotorLog.find(query).sort({ createdAt: -1 }).skip(page * limit).limit(limit);
                        
                        const logStrings = logs.map(log => {
                            const formatBD = (date) => {
                                if (!date) return 'N/A';
                                const optionsDate = { timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric' };
                                const optionsTime = { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true };
                                return new Intl.DateTimeFormat('en-GB', optionsDate).format(date) + ' ' + 
                                       new Intl.DateTimeFormat('en-US', optionsTime).format(date);
                            };
                            return JSON.stringify({
                                onTime: formatBD(log.startTime),
                                offTime: log.bdDate + ' ' + log.bdTime,
                                duration: log.duration
                            });
                        });
                        ws.send(JSON.stringify({ type: 'logPageUpdate', payload: { motorLogs: logStrings, currentPage: page, totalPages: totalPages }}));
                    } catch (err) {}
                } else if (data.command === 'CLEAR_LOGS') {
                    try {
                        await MotorLog.deleteMany({ macAddress: targetMac });
                        const state = await getDeviceState(targetMac);
                        broadcastToWebClients(targetMac, JSON.stringify({
                            type: 'statusUpdate',
                            payload: { lastAction: "Logs Cleared", motorStatus: state.lastMotorStatus, systemMode: "Normal" }
                        }));
                    } catch (err) {}
                } else if (data.command === 'GET_SCHEDULES') {
                    try {
                        const schedules = await MotorSchedule.find({ macAddress: targetMac }).sort({ createdAt: -1 });
                        ws.send(JSON.stringify({ type: 'scheduleUpdate', payload: schedules }));
                    } catch (err) {}
                } else if (data.command === 'ADD_SCHEDULE') {
                    try {
                        const newSchedule = new MotorSchedule({ ...data.value, macAddress: targetMac });
                        await newSchedule.save();
                        const schedules = await MotorSchedule.find({ macAddress: targetMac }).sort({ createdAt: -1 });
                        broadcastToWebClients(targetMac, JSON.stringify({ type: 'scheduleUpdate', payload: schedules }));
                    } catch (err) {}
                } else if (data.command === 'DELETE_SCHEDULE') {
                    try {
                        await MotorSchedule.findByIdAndDelete(data.value);
                        const schedules = await MotorSchedule.find({ macAddress: targetMac }).sort({ createdAt: -1 });
                        broadcastToWebClients(targetMac, JSON.stringify({ type: 'scheduleUpdate', payload: schedules }));
                    } catch (err) {}
                } else if (data.command === 'TOGGLE_SCHEDULE') {
                    try {
                        const sched = await MotorSchedule.findById(data.value);
                        if(sched && sched.macAddress === targetMac) {
                            sched.isActive = !sched.isActive;
                            await sched.save();
                            const schedules = await MotorSchedule.find({ macAddress: targetMac }).sort({ createdAt: -1 });
                            broadcastToWebClients(targetMac, JSON.stringify({ type: 'scheduleUpdate', payload: schedules }));
                        }
                    } catch (err) {}
                } else if (data.command === 'TOGGLE_ALWAYS_ON') {
                    const state = await getDeviceState(targetMac);
                    state.alwaysOn = data.value;
                    await SystemSettings.findOneAndUpdate({macAddress: targetMac}, {isAlwaysOn: state.alwaysOn}, {upsert: true});
                    
                    broadcastToWebClients(targetMac, JSON.stringify({ type: 'alwaysOnUpdate', payload: state.alwaysOn }));
                    
                    const targetEsp = esp32Clients.get(targetMac);
                    if (targetEsp && targetEsp.readyState === WebSocket.OPEN) {
                        if (state.alwaysOn && state.lastMotorStatus === 'OFF') {
                            targetEsp.send(JSON.stringify({ command: 'RELAY_1_ALWAYS' }));
                        } else if (!state.alwaysOn && state.lastMotorStatus === 'ON') {
                            targetEsp.send(JSON.stringify({ command: 'RELAY_2_AUTO' }));
                        }
                    }
                } else if (data.command === 'GET_ALWAYS_ON') {
                    const state = await getDeviceState(targetMac);
                    ws.send(JSON.stringify({ type: 'alwaysOnUpdate', payload: state.alwaysOn }));
                } else {
                     // Forward to specific ESP32
                    const targetEsp = esp32Clients.get(targetMac);
                    if (targetEsp && targetEsp.readyState === WebSocket.OPEN) {
                        targetEsp.send(message.toString());
                    }
                }
            }

        } else if (data.type === 'statusUpdate' && esp32Clients.has(ws.macAddress)) {
            // Handle ESP32 Status Updates
            const clientMac = ws.macAddress;
            const payload = data.payload;
            const currentMotorStatus = payload.motorStatus;
            
            getDeviceState(clientMac).then(state => {
                if (currentMotorStatus === 'ON' && state.lastMotorStatus === 'OFF') {
                    state.motorStartTime = new Date();
                } else if (currentMotorStatus === 'OFF' && state.lastMotorStatus === 'ON' && state.motorStartTime) {
                    const motorStopTime = new Date();
                    const durationMs = motorStopTime - state.motorStartTime;
                    const durationSec = Math.floor(durationMs / 1000);
                    
                    let durationStr = "";
                    const hours = Math.floor(durationSec / 3600);
                    const minutes = Math.floor((durationSec % 3600) / 60);
                    const seconds = durationSec % 60;
                    
                    if (hours > 0) durationStr += `${hours}h `;
                    if (minutes > 0 || hours > 0) durationStr += `${minutes}m `;
                    durationStr += `${seconds}s`;

                    if (durationSec >= 2) {
                        const optionsDate = { timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric' };
                        const optionsTime = { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true };
                        
                        let bdDateFinal;
                        try {
                           const bdDateParts = new Intl.DateTimeFormat('en-GB', optionsDate).formatToParts(motorStopTime);
                           const day = bdDateParts.find(p => p.type === 'day').value;
                           const month = bdDateParts.find(p => p.type === 'month').value;
                           const year = bdDateParts.find(p => p.type === 'year').value;
                           bdDateFinal = `${day}/${month}/${year}`;
                        } catch(e) {
                           bdDateFinal = motorStopTime.toLocaleDateString();
                        }
                        
                        const bdTimeFinal = motorStopTime.toLocaleTimeString('en-US', optionsTime);

                        new MotorLog({
                            macAddress: clientMac,
                            startTime: state.motorStartTime,
                            endTime: motorStopTime,
                            duration: durationStr,
                            bdDate: bdDateFinal,
                            bdTime: bdTimeFinal
                        }).save().catch(console.error);
                    }
                    state.motorStartTime = null; 
                }
                state.lastMotorStatus = currentMotorStatus;

                // Broadcast
                broadcastToWebClients(clientMac, message.toString());
            });
        }
    });

    ws.on('close', () => {
        clearTimeout(identificationTimeout);
        if (ws.macAddress && esp32Clients.get(ws.macAddress) === ws) {
            console.log(`ESP32 ${ws.macAddress} disconnected.`);
            esp32Clients.delete(ws.macAddress);
            broadcastToWebClients(ws.macAddress, JSON.stringify({ type: 'espStatus', status: 'offline' }));
        } else if (webClients.has(ws)) {
            webClients.delete(ws);
        }
    });
});

// --- Automation Engine ---
setInterval(async () => {
    try {
        const schedules = await MotorSchedule.find({ isActive: true });
        if(schedules.length === 0) return;

        const now = new Date();
        const bdTimeStr = now.toLocaleString("en-US", { timeZone: "Asia/Dhaka", hour12: false, hour: '2-digit', minute: '2-digit' });
        const bdDateStrList = now.toLocaleString("en-US", { timeZone: "Asia/Dhaka", year:'numeric', month:'2-digit', day:'2-digit' }).split('/');
        const bdDate = new Date(`${bdDateStrList[2]}-${bdDateStrList[0]}-${bdDateStrList[1]}T00:00:00`); 
        const currentWeekday = bdDate.getDay(); 

        schedules.forEach(sched => {
            let matchesDay = false;
            if (sched.type === 'DAILY') matchesDay = true;
            else if (sched.type === 'WEEKLY' && sched.daysOfWeek && sched.daysOfWeek.includes(currentWeekday)) matchesDay = true;
            else if (sched.type === 'DATE_RANGE') {
                const sDate = new Date(sched.startDate); sDate.setHours(0,0,0,0);
                const eDate = new Date(sched.endDate); eDate.setHours(23,59,59,999);
                if (bdDate >= sDate && bdDate <= eDate) matchesDay = true;
            }

            if (matchesDay) {
                const targetEsp = esp32Clients.get(sched.macAddress);
                if (targetEsp && targetEsp.readyState === WebSocket.OPEN) {
                    if (sched.startTime === bdTimeStr) targetEsp.send(JSON.stringify({ command: 'RELAY_1_AUTO' }));
                    if (sched.endTime === bdTimeStr) targetEsp.send(JSON.stringify({ command: 'RELAY_2_AUTO' }));
                }
            }
        });
    } catch (err) {}
}, 60000); 

// ALWAYS ON ENFORCER: 5-Minute Ticker
setInterval(async () => {
    for (const [mac, state] of deviceStates.entries()) {
        if (state.alwaysOn && state.lastMotorStatus === 'OFF') {
            const targetEsp = esp32Clients.get(mac);
            if (targetEsp && targetEsp.readyState === WebSocket.OPEN) {
                targetEsp.send(JSON.stringify({ command: 'RELAY_1_ALWAYS' }));
            }
        }
    }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
