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

// Updated Schema as per user request
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

const defaultQuickUssds = [
    { id: '1', code: '*566#', label: 'GP' },
    { id: '2', code: '*121#', label: 'BL/Robi' },
    { id: '3', code: '*222#', label: 'Robi/Air' },
    { id: '4', code: '*152#', label: 'Teletalk' }
];

const SettingsSchema = new mongoose.Schema({
    isAlwaysOn: { type: Boolean, default: false },
    adminPhones: { type: [String], default: [] },
    quickUssds: { type: Array, default: defaultQuickUssds }
});
const SystemSettings = mongoose.model('SystemSettings8c', SettingsSchema);

let globalAlwaysOn = false;
let globalAdminPhones = [];
let globalQuickUssds = defaultQuickUssds;
SystemSettings.findOne().then(doc => {
    if(!doc) { new SystemSettings().save(); }
    else {
        globalAlwaysOn = doc.isAlwaysOn;
        if (doc.adminPhones && Array.isArray(doc.adminPhones)) {
            globalAdminPhones = doc.adminPhones;
        } else if (doc.adminPhone) {
            globalAdminPhones = [doc.adminPhone];
        }
        if (doc.quickUssds && Array.isArray(doc.quickUssds) && doc.quickUssds.length > 0) {
            globalQuickUssds = doc.quickUssds;
        }
    }
}).catch(console.error);

// --- Static Files ---
// Serve files from the sibling 'Dashboard' directory
app.use(express.static(path.join(__dirname, '../Dashboard')));

app.get('/status', (req, res) => {
    res.send('server is running');
});

// Explicit root handler as requested
app.get('/', (req, res) => {
    res.send('server is running ...');
});

const wss = new WebSocket.Server({ server });

let esp32Client = null;
const webClients = new Set();

// --- Motor State Tracking ---
let motorStartTime = null;
let lastMotorStatus = 'OFF';
const DEVICE_MAC = "68:FE:71:8A:85:30"; // Hardcoded MAC

wss.on('connection', (ws) => {
    console.log('A client connected. Waiting for identification...');

    ws.isIdentified = false;

    const identificationTimeout = setTimeout(() => {
        if (!ws.isIdentified) {
            console.log('Client did not identify. Assuming it is a web client.');
            webClients.add(ws);
            ws.isIdentified = true;
            const espStatus = (esp32Client && esp32Client.readyState === WebSocket.OPEN) ? 'online' : 'offline';
            ws.send(JSON.stringify({ type: 'espStatus', status: espStatus }));
            
            // Send current motor status if known
            if (lastMotorStatus !== 'OFF') {
                 // You might want to send the last known full payload here if you stored it
            }
        }
    }, 2000);

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            // console.error('Invalid JSON received:', message.toString());
            return;
        }

        if (data.type === 'esp32-identify' && !ws.isIdentified) {
            clearTimeout(identificationTimeout);
            console.log('ESP32 client identified.');
            esp32Client = ws;
            ws.isIdentified = true;
            
            webClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'espStatus', status: 'online' }));
                }
            });

            // Initial Always ON Trigger upon device coming online
            if (globalAlwaysOn) {
                console.log("Always ON Enforcer: Triggering Motor ON upon ESP32 Connection.");
                ws.send('{"command":"RELAY_1_ALWAYS"}');
            }

            // Sync Admin Phones with ESP32
            if (globalAdminPhones.length > 0) {
                ws.send(JSON.stringify({ command: 'SET_PHONES', value: globalAdminPhones }));
            }

        } else if (data.type === 'web-identify' && !ws.isIdentified) {
            clearTimeout(identificationTimeout);
            console.log('Web client identified explicitly.');
            webClients.add(ws);
            ws.isIdentified = true;
            const espStatus = (esp32Client && esp32Client.readyState === WebSocket.OPEN) ? 'online' : 'offline';
            ws.send(JSON.stringify({ type: 'espStatus', status: espStatus }));
            
            // Send known motor status and admin phones
            ws.send(JSON.stringify({
                type: 'statusUpdate',
                payload: {
                   lastAction: "Server connected", 
                   motorStatus: lastMotorStatus,
                   systemMode: "Normal"
                }
            }));
            ws.send(JSON.stringify({ type: 'phoneListUpdate', payload: globalAdminPhones }));
            ws.send(JSON.stringify({ type: 'quickUssdUpdate', payload: globalQuickUssds }));
            

        } else if (data.type === 'command' && ws !== esp32Client) {
            // Handle Web Client Commands
            if (data.command === 'GET_LOG_PAGE') {
                const page = data.value || 0;
                const limit = 10;
                
                // Build Query
                let query = {};
                if (data.startDate && data.endDate) {
                    const start = new Date(data.startDate);
                    start.setHours(0,0,0,0);
                    
                    const end = new Date(data.endDate);
                    end.setHours(23,59,59,999);
                    
                    query.startTime = { $gte: start, $lte: end };
                    console.log(`Filtering logs from ${start} to ${end}`);
                }

                try {
                    const totalLogs = await MotorLog.countDocuments(query);
                    const totalPages = Math.ceil(totalLogs / limit);
                    const logs = await MotorLog.find(query)
                        .sort({ createdAt: -1 })
                        .skip(page * limit)
                        .limit(limit);
                    
                    const logStrings = logs.map(log => {
                        // Helper to format Date to BD Time
                        const formatBD = (date) => {
                            if (!date) return 'N/A';
                            const optionsDate = { timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric' };
                            const optionsTime = { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true };
                            return new Intl.DateTimeFormat('en-GB', optionsDate).format(date) + ' ' + 
                                   new Intl.DateTimeFormat('en-US', optionsTime).format(date);
                        };

                        return JSON.stringify({
                            onTime: formatBD(log.startTime),
                            offTime: log.bdDate + ' ' + log.bdTime, // stored BD time is end time
                            duration: log.duration
                        });
                    });

                    ws.send(JSON.stringify({
                        type: 'logPageUpdate',
                        payload: {
                            motorLogs: logStrings,
                            currentPage: page,
                            totalPages: totalPages
                        }
                    }));
                } catch (err) {
                    console.error("Error fetching logs:", err);
                }
            } else if (data.command === 'CLEAR_LOGS') {
                try {
                    await MotorLog.deleteMany({});
                    console.log("All logs cleared.");
                    // Notify all web clients
                     webClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                             client.send(JSON.stringify({
                                 type: 'statusUpdate',
                                 payload: {
                                    lastAction: "Logs Cleared", 
                                    motorStatus: lastMotorStatus,
                                    systemMode: "Normal"
                                 }
                             }));
                        }
                    });
                } catch (err) {
                    console.error("Error clearing logs:", err);
                }
            } else if (data.command === 'GET_SCHEDULES') {
                try {
                    const schedules = await MotorSchedule.find().sort({ createdAt: -1 });
                    ws.send(JSON.stringify({ type: 'scheduleUpdate', payload: schedules }));
                } catch (err) { console.error("Error fetching schedules", err); }
            } else if (data.command === 'ADD_SCHEDULE') {
                try {
                    const newSchedule = new MotorSchedule(data.value);
                    await newSchedule.save();
                    const schedules = await MotorSchedule.find().sort({ createdAt: -1 });
                    webClients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'scheduleUpdate', payload: schedules }));
                    });
                } catch (err) { console.error("Error adding schedule", err); }
            } else if (data.command === 'DELETE_SCHEDULE') {
                try {
                    await MotorSchedule.findByIdAndDelete(data.value);
                    const schedules = await MotorSchedule.find().sort({ createdAt: -1 });
                    webClients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'scheduleUpdate', payload: schedules }));
                    });
                } catch (err) { console.error("Error deleting schedule", err); }
            } else if (data.command === 'TOGGLE_SCHEDULE') {
                try {
                    const sched = await MotorSchedule.findById(data.value);
                    if(sched) {
                        sched.isActive = !sched.isActive;
                        await sched.save();
                        const schedules = await MotorSchedule.find().sort({ createdAt: -1 });
                        webClients.forEach(c => {
                            if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'scheduleUpdate', payload: schedules }));
                        });
                    }
                } catch (err) { console.error("Error toggling schedule", err); }
            } else if (data.command === 'TOGGLE_ALWAYS_ON') {
                globalAlwaysOn = data.value;
                SystemSettings.findOneAndUpdate({}, {isAlwaysOn: globalAlwaysOn}, {upsert: true}).catch(console.error);
                webClients.forEach(c => {
                    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'alwaysOnUpdate', payload: globalAlwaysOn }));
                });
                
                if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
                    if (globalAlwaysOn && lastMotorStatus === 'OFF') {
                        console.log("Always ON Enabled: Force starting motor");
                        esp32Client.send(JSON.stringify({ command: 'RELAY_1_ALWAYS' }));
                    } else if (!globalAlwaysOn && lastMotorStatus === 'ON') {
                        console.log("Always ON Disabled: Force stopping motor");
                        esp32Client.send(JSON.stringify({ command: 'RELAY_2_AUTO' }));
                    }
                }
            } else if (data.command === 'GET_ALWAYS_ON') {
                ws.send(JSON.stringify({ type: 'alwaysOnUpdate', payload: globalAlwaysOn }));
            } else if (data.command === 'GET_PHONES' || data.command === 'GET_PHONE') {
                ws.send(JSON.stringify({ type: 'phoneListUpdate', payload: globalAdminPhones }));
            } else if (data.command === 'GET_QUICK_USSD') {
                ws.send(JSON.stringify({ type: 'quickUssdUpdate', payload: globalQuickUssds }));
            } else if (data.command === 'SET_QUICK_USSD') {
                if (Array.isArray(data.value)) {
                    globalQuickUssds = data.value;
                    SystemSettings.findOneAndUpdate({}, { quickUssds: globalQuickUssds }, { upsert: true }).catch(console.error);
                    webClients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) {
                            c.send(JSON.stringify({ type: 'quickUssdUpdate', payload: globalQuickUssds }));
                        }
                    });
                }
            } else if (data.command === 'ADD_PHONE') {
                const phoneToAdd = String(data.value || "").trim();
                if (phoneToAdd.length >= 10 && globalAdminPhones.length < 5) {
                    if (!globalAdminPhones.includes(phoneToAdd)) {
                        globalAdminPhones.push(phoneToAdd);
                        SystemSettings.findOneAndUpdate({}, { adminPhones: globalAdminPhones }, { upsert: true }).catch(console.error);
                        console.log("Admin phone added. Current list:", globalAdminPhones);
                        
                        if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
                            esp32Client.send(JSON.stringify({ command: 'SET_PHONES', value: globalAdminPhones }));
                        }
                        webClients.forEach(c => {
                            if (c.readyState === WebSocket.OPEN) {
                                c.send(JSON.stringify({ type: 'phoneListUpdate', payload: globalAdminPhones }));
                            }
                        });
                    }
                }
            } else if (data.command === 'REMOVE_PHONE') {
                const phoneToRemove = String(data.value || "").trim();
                const initialLen = globalAdminPhones.length;
                globalAdminPhones = globalAdminPhones.filter(p => p !== phoneToRemove);
                if (globalAdminPhones.length !== initialLen) {
                    SystemSettings.findOneAndUpdate({}, { adminPhones: globalAdminPhones }, { upsert: true }).catch(console.error);
                    console.log("Admin phone removed. Current list:", globalAdminPhones);
                    
                    if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
                        esp32Client.send(JSON.stringify({ command: 'SET_PHONES', value: globalAdminPhones }));
                    }
                    webClients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) {
                            c.send(JSON.stringify({ type: 'phoneListUpdate', payload: globalAdminPhones }));
                        }
                    });
                }
            } else if (data.command === 'SET_PHONES') {
                if (Array.isArray(data.value)) {
                    globalAdminPhones = data.value.slice(0, 5).map(p => String(p).trim()).filter(p => p.length >= 10);
                    SystemSettings.findOneAndUpdate({}, { adminPhones: globalAdminPhones }, { upsert: true }).catch(console.error);
                    if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
                        esp32Client.send(JSON.stringify({ command: 'SET_PHONES', value: globalAdminPhones }));
                    }
                    webClients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) {
                            c.send(JSON.stringify({ type: 'phoneListUpdate', payload: globalAdminPhones }));
                        }
                    });
                }
            } else {
                 // Forward other commands (RELAY, RESET, RESTART) to ESP32
                if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
                    console.log('Forwarding command to ESP32:', message.toString());
                    esp32Client.send(message.toString());
                }
            }

        } else if ((data.type === 'phoneListUpdate' || data.type === 'phoneUpdate') && ws === esp32Client) {
            if (Array.isArray(data.phones || data.payload)) {
                globalAdminPhones = (data.phones || data.payload).slice(0, 5);
            } else if (data.phone) {
                if (!globalAdminPhones.includes(data.phone) && globalAdminPhones.length < 5) {
                    globalAdminPhones.push(data.phone);
                }
            }
            console.log("Phone list updated from ESP32:", globalAdminPhones);
            SystemSettings.findOneAndUpdate({}, { adminPhones: globalAdminPhones }, { upsert: true }).catch(console.error);
            webClients.forEach(c => {
                if (c.readyState === WebSocket.OPEN) {
                    c.send(JSON.stringify({ type: 'phoneListUpdate', payload: globalAdminPhones }));
                }
            });
        } else if (data.type === 'ussdResponse' && ws === esp32Client) {
            console.log("USSD response from ESP32:", data);
            webClients.forEach(c => {
                if (c.readyState === WebSocket.OPEN) {
                    c.send(message.toString());
                }
            });
        } else if (data.type === 'statusUpdate' && ws === esp32Client) {
            // Handle ESP32 Status Updates
            const payload = data.payload;
            const currentMotorStatus = payload.motorStatus;

            // Logic to track duration and save log
            if (currentMotorStatus === 'ON' && lastMotorStatus === 'OFF') {
                motorStartTime = new Date();
                console.log("Motor Started at:", motorStartTime);
            } else if (currentMotorStatus === 'OFF' && lastMotorStatus === 'ON' && motorStartTime) {
                const motorStopTime = new Date();
                const durationMs = motorStopTime - motorStartTime;
                const durationSec = Math.floor(durationMs / 1000);
                
                // Format Duration
                let durationStr = "";
                const hours = Math.floor(durationSec / 3600);
                const minutes = Math.floor((durationSec % 3600) / 60);
                const seconds = durationSec % 60;
                
                if (hours > 0) durationStr += `${hours}h `;
                if (minutes > 0 || hours > 0) durationStr += `${minutes}m `;
                durationStr += `${seconds}s`;

                // Filter: Ignore logs less than 2 seconds (Switch bounce / noise)
                if (durationSec < 2) {
                     console.log(`Skipping Short Log (${durationSec}s)`);
                } else {
                    // Format BD Date/Time
                    const optionsDate = { timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric' };
                    // ... (rest of code)
                    const optionsTime = { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true };
                    
                     // Enforcing DD/MM/YYYY for BD Date
                    try {
                       const bdDateParts = new Intl.DateTimeFormat('en-GB', optionsDate).formatToParts(motorStopTime);
                       const day = bdDateParts.find(p => p.type === 'day').value;
                       const month = bdDateParts.find(p => p.type === 'month').value;
                       const year = bdDateParts.find(p => p.type === 'year').value;
                       var bdDateFinal = `${day}/${month}/${year}`;
                    } catch(e) {
                       var bdDateFinal = motorStopTime.toLocaleDateString();
                    }
                    
                    const bdTimeFinal = motorStopTime.toLocaleTimeString('en-US', optionsTime);

                    console.log(`Motor Stopped. Duration: ${durationStr}`);

                    // Save to MongoDB
                    const newLog = new MotorLog({
                        macAddress: DEVICE_MAC,
                        startTime: motorStartTime,
                        endTime: motorStopTime,
                        duration: durationStr,
                        bdDate: bdDateFinal,
                        bdTime: bdTimeFinal
                    });
                    newLog.save().then(() => console.log("Log saved to DB")).catch(err => console.error(err));
                }

                motorStartTime = null; 
            }
            lastMotorStatus = currentMotorStatus;

            // Forward status to all web clients
            webClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message.toString());
                }
            });
        }
    });

    ws.on('close', () => {
        clearTimeout(identificationTimeout);
        if (ws === esp32Client) {
            console.log('ESP32 client disconnected.');
            esp32Client = null;
            // Reset state? maybe not
            webClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'espStatus', status: 'offline' }));
                }
            });
        } else {
            webClients.delete(ws);
            console.log('Web client disconnected.');
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
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

        let triggerOn = false;
        let triggerOff = false;

        schedules.forEach(sched => {
            let matchesDay = false;
            if (sched.type === 'DAILY') {
                matchesDay = true;
            } else if (sched.type === 'WEEKLY') {
                if (sched.daysOfWeek && sched.daysOfWeek.includes(currentWeekday)) {
                    matchesDay = true;
                }
            } else if (sched.type === 'DATE_RANGE') {
                const sDate = new Date(sched.startDate); sDate.setHours(0,0,0,0);
                const eDate = new Date(sched.endDate); eDate.setHours(23,59,59,999);
                if (bdDate >= sDate && bdDate <= eDate) {
                    matchesDay = true;
                }
            }

            if (matchesDay) {
                if (sched.startTime === bdTimeStr) triggerOn = true;
                if (sched.endTime === bdTimeStr) triggerOff = true;
            }
        });

        if (triggerOn) {
            console.log("Automation Engine: Triggering Motor ON");
            if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
                esp32Client.send(JSON.stringify({ command: 'RELAY_1_AUTO' }));
            }
        }
        if (triggerOff) {
            console.log("Automation Engine: Triggering Motor OFF");
            if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
                esp32Client.send(JSON.stringify({ command: 'RELAY_2_AUTO' }));
            }
        }
    } catch (err) {
        console.error("Automation error:", err);
    }
}, 60000); // 1 minute ticker

// ALWAYS ON ENFORCER: 5-Minute Ticker
setInterval(() => {
    if (globalAlwaysOn && lastMotorStatus === 'OFF' && esp32Client && esp32Client.readyState === WebSocket.OPEN) {
        console.log("Always ON Enforcer (5 Min Check): Found Motor OFF, Triggering ON");
        esp32Client.send(JSON.stringify({ command: 'RELAY_1_ALWAYS' }));
    }
}, 5 * 60 * 1000); // 5 minutes

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
    console.log('server is running');
});
