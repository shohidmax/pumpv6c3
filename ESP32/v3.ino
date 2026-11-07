// =================================================================
// ESP32 Simple WebSocket Client - Fixed & Optimized (Always Connected) .....................................
// =================================================================

#include <WiFi.h>
#include <WiFiManager.h> // https://github.com/tzapu/WiFiManager
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Update.h>
#include <esp_task_wdt.h>
#include <nvs_flash.h>
#include <Preferences.h>

// --- SIM800L GSM CONFIGURATION ---
#define SIM800_RX_PIN 16 // ESP32 D16 (RX2) -> SIM800L TXD
#define SIM800_TX_PIN 17 // ESP32 D17 (TX2) -> SIM800L RXD
#define SIM800_BAUD 9600

Preferences prefs;
const int MAX_ADMIN_PHONES = 5;
String adminPhones[MAX_ADMIN_PHONES];
int adminPhoneCount = 0;

String simBuffer = "";
bool inCall = false;
unsigned long callStartTime = 0;
const unsigned long maxCallDuration = 45000; // 45 seconds auto-hangup
bool isNextLineSMSBody = false;
String smsSenderNumber = "";

// USSD Variables
String currentUSSDCode = "";
unsigned long ussdStartTime = 0;
bool waitingForUSSD = false;

void initSIM800();
void handleSIM800();
void processSIMLine(String line);
void handleIncomingSMS(String sender, String text);
void sendSMS(String number, String message);
void saveAdminPhones();
void loadAdminPhones();
bool addAdminPhone(String newPhone);
bool removeAdminPhone(String phoneToRemove);
bool isAuthorizedNumber(String incomingNum);
void sendPhoneListWS();
void dialUSSD(String code);
String decodeUSSD(String raw);

// --- DFPLAYER MINI MP3 MODULE CONFIGURATION ---
// D27 -> DFPlayer Mini RX (pin 2) [ESP32 TX]
// D14 -> DFPlayer Mini TX (pin 3) [ESP32 RX]
#define DFPLAYER_RX_PIN 14 // ESP32 D14 (RX) <- DFPlayer Mini TX
#define DFPLAYER_TX_PIN 27 // ESP32 D27 (TX) -> DFPlayer Mini RX
#define DFPLAYER_BAUD 9600

#define AUDIO_CALL_ANSWER 1 // 001.mp3 - Call Received / Greeting prompt
#define AUDIO_MOTOR_ON    6 // 006.mp3 - Motor ON Audio
#define AUDIO_MOTOR_OFF   9 // 009.mp3 - Motor OFF Audio

// --- AUDIO TRACK LENGTHS / DURATIONS (in milliseconds) ---
// অডিও ফাইলের দৈর্ঘ্য অনুযায়ী সময় (মিলি-সেকেন্ডে)
unsigned long audioDuration_001 = 8000; // 001.mp3: Call Greeting length (8 seconds)
unsigned long audioDuration_006 = 5000; // 006.mp3: Motor ON Audio length (5 seconds)
unsigned long audioDuration_009 = 5000; // 009.mp3: Motor OFF Audio length (5 seconds)

// Audio playback state tracking
bool isAudioPlaying = false;
unsigned long audioStartTime = 0;
unsigned long currentAudioDuration = 0;
int currentPlayingTrack = 0;
bool hangupAfterAudio = false;

HardwareSerial dfSerial(1); // Hardware UART1 for DFPlayer Mini

void initDFPlayer();
void handleDFPlayer();
void onAudioFinished();
void playAudio(int trackNumber, unsigned long durationMs = 0, bool autoHangup = false);
void setAudioVolume(int volume);
void stopAudio();

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#ifndef WHITE
#define WHITE SSD1306_WHITE
#endif
#ifndef BLACK
#define BLACK SSD1306_BLACK
#endif

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
bool displayFound = false;
unsigned long lastDisplayUpdate = 0;
const unsigned long displayUpdateInterval = 1000;
bool displayBlink = false;

// --- Configuration ---
const char* websocket_server_host = "pvrv3.maxapi.esp32.site";
const uint16_t websocket_server_port = 443;
#define WDT_TIMEOUT 30 // 30 Seconds Watchdog

// Updated URLs from your latest code
const char* firmwareUrl = "https://github.com/shohidmax/pumpv6c3/releases/download/c6v3/v3.ino.bin";
const char* versionUrl = "https://raw.githubusercontent.com/shohidmax/pumpv6c3/refs/heads/main/Server/version.txt";
// Current firmware version
const char* currentFirmwareVersion = "1.1.9";

// Timers
unsigned long lastUpdateCheck = 0;
const unsigned long updateCheckInterval = 5 * 60 * 1000; // 5 minutes

unsigned long lastWifiCheck = 0;
const unsigned long wifiCheckInterval = 10000; // Check WiFi every 10 seconds

// --- PIN DEFINITIONS ---
#define RELAY_1 25
#define RELAY_2 26
#define BUZZER_PIN 13 // Previously relay_3
#define SWITCH_1 18
#define SWITCH_2 19

// --- GLOBAL VARIABLES ---
WebSocketsClient webSocket;
unsigned long relay1_timer = 0;
unsigned long relay2_timer = 0;
unsigned long buzzer_timer = 0;
const int relay_duration = 1000; // 1 Second Pulse
const int buzzer_duration = 200; // 200ms Beep

String deviceLastAction = "System Boot";
unsigned long lastStatusUpdate = 0;
String lastMotorStat = "";
String lastSysMode = "";
int lastWifiSignal = 0;
bool isServerConnected = false;

// --- FORWARD DECLARATIONS ---
void checkForFirmwareUpdate();
String fetchLatestVersion();
void downloadAndApplyFirmware();
bool startOTAUpdate(WiFiClient* client, int contentLength);

// --- FUNCTIONS ---
void beep() {
    digitalWrite(BUZZER_PIN, HIGH);
    buzzer_timer = millis();
}

// Debounce Variables
unsigned long lastDebounceTime = 0;
unsigned long debounceDelay = 200; // 200ms debounce
String stableMotorState = "OFF";

void sendStatus() {
    String reading = (digitalRead(SWITCH_1) == LOW) ? "ON" : "OFF";
    String currentMode = (digitalRead(SWITCH_2) == LOW) ? "Normal" : "Emergency";
    int currentSignal = constrain(map(WiFi.RSSI(), -100, -30, 0, 100), 0, 100);

    // Debounce Logic for Motor Switch
    if (reading != lastMotorStat) { // Use lastMotorStat as 'lastReading' temporary
       // State changed, but might be noise. We handle the actual stable state separately.
       // Actually, let's keep it simple: Only update 'stableMotorState' if value persists
    }
    
    // Better simpler debounce:
    // Only accept a state change if it stays that way for > 50ms? 
    // Or just throttle updates?
    
    // Let's go with: Read, wait 50ms, Read again. If same, valid.
    // But we are in a loop.
    
    // Let's use the 'lastStatusUpdate' throttling but specificaly for motor state changes,
    // we need to be sure.
    
    // If reading is different from known stable state
    if (reading != stableMotorState) {
       if ((millis() - lastDebounceTime) > debounceDelay) {
         stableMotorState = reading; // Update stable state
         deviceLastAction = (stableMotorState == "ON") ? "Motor ON (Switch)" : "Motor OFF (Switch)";
         lastDebounceTime = millis();
       }
    } else {
       lastDebounceTime = millis(); // Reset timer if reading matches stable
    }
    
    // Use stableMotorState for payload
    String currentMotor = stableMotorState;

    // Send data if Stable Motor Status changed (compared to what we Last Sent) OR other triggers
    // We reuse 'lastMotorStat' to track what was SENT to server
    if (currentMotor != lastMotorStat || currentMode != lastSysMode || abs(currentSignal - lastWifiSignal) > 5 || millis() - lastStatusUpdate > 5000) {
        
        JsonDocument doc;
        doc["type"] = "statusUpdate";
        
        JsonObject payload = doc.createNestedObject("payload");
        payload["motorStatus"] = currentMotor;
        payload["systemMode"] = currentMode;
        payload["wifiSignal"] = currentSignal;
        payload["localIP"] = WiFi.localIP().toString();
        payload["wifiSSID"] = WiFi.SSID();
        payload["version"] = currentFirmwareVersion;
        payload["lastAction"] = deviceLastAction;
        
        String jsonString;
        serializeJson(doc, jsonString);
        webSocket.sendTXT(jsonString);

        lastMotorStat = currentMotor;
        lastSysMode = currentMode;
        lastWifiSignal = currentSignal;
        lastStatusUpdate = millis();
    }
}

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
    esp_task_wdt_reset(); // Reset Watchdog on activity
    switch(type) {
        case WStype_DISCONNECTED:
            Serial.println("[WSc] Disconnected!");
            isServerConnected = false;
            break;
        case WStype_CONNECTED:
            Serial.println("[WSc] Connected!");
            isServerConnected = true;
            webSocket.sendTXT("{\"type\":\"esp32-identify\"}");
            sendPhoneListWS();
            break;
        case WStype_TEXT: {
            JsonDocument doc;
            DeserializationError error = deserializeJson(doc, payload);
            if (!error) {
                String command = doc["command"];
                if (command == "RELAY_1" || command == "RELAY_1_AUTO" || command == "RELAY_1_ALWAYS") {
                    digitalWrite(RELAY_1, HIGH);
                    relay1_timer = millis();
                    beep();
                    if (command == "RELAY_1_AUTO") deviceLastAction = "Motor ON (Auto)";
                    else if (command == "RELAY_1_ALWAYS") deviceLastAction = "Motor ON (Always Mode)";
                    else deviceLastAction = "Motor ON (Remote)";
                    playAudio(AUDIO_MOTOR_ON);
                } else if (command == "RELAY_2" || command == "RELAY_2_AUTO") {
                    digitalWrite(RELAY_2, HIGH);
                    relay2_timer = millis();
                    beep();
                    if (command == "RELAY_2_AUTO") deviceLastAction = "Motor OFF (Auto)";
                    else deviceLastAction = "Motor OFF (Remote)";
                    playAudio(AUDIO_MOTOR_OFF);
                } else if (command == "RESET") {
                    beep();
                    deviceLastAction = "System Reset";
                } else if (command == "RESTART_ESP") {
                    webSocket.disconnect();
                    delay(500);
                    ESP.restart();
                } else if (command == "CHECK_UPDATE") {
                    checkForFirmwareUpdate();
                } else if (command == "ADD_PHONE") {
                    String newP = doc["value"] | "";
                    if (newP.length() >= 10) addAdminPhone(newP);
                } else if (command == "REMOVE_PHONE") {
                    String remP = doc["value"] | "";
                    if (remP.length() >= 10) removeAdminPhone(remP);
                } else if (command == "SET_PHONES") {
                    if (doc["value"].is<JsonArray>()) {
                        adminPhoneCount = 0;
                        JsonArray arr = doc["value"].as<JsonArray>();
                        for (JsonVariant v : arr) {
                            String p = v.as<String>();
                            p.trim();
                            if (p.length() >= 10 && adminPhoneCount < MAX_ADMIN_PHONES) {
                                adminPhones[adminPhoneCount++] = p;
                            }
                        }
                        saveAdminPhones();
                    }
                } else if (command == "GET_PHONES" || command == "GET_PHONE") {
                    sendPhoneListWS();
                } else if (command == "DIAL_USSD") {
                    String code = doc["value"] | "";
                    if (code.length() > 0) dialUSSD(code);
                } else if (command == "PLAY_AUDIO") {
                    int track = doc["value"] | (doc["track"] | 1);
                    playAudio(track);
                } else if (command == "SET_VOLUME") {
                    int vol = doc["value"] | (doc["volume"] | 28);
                    setAudioVolume(vol);
                } else if (command == "STOP_AUDIO") {
                    stopAudio();
                } else if (command == "PASSWORD_CHANGED_SMS") {
                    String targetPhone = doc["phone"] | "";
                    String newPass = doc["newPassword"] | "";
                    if (targetPhone.length() >= 10 && newPass.length() > 0) {
                        sendSMS(targetPhone, "Pump Controller password has been changed to: " + newPass);
                    }
                }
                // Send immediate update after command
                lastStatusUpdate = 0; // Force update
            }
            break;
        }
    }
}

#include <Ticker.h> // Ticker for LED blinking

// LED Definition
#define LED_PIN 2
Ticker blinker;

// --- DFPLAYER MINI HELPER FUNCTIONS ---
uint8_t dfRxBuf[10];
uint8_t dfRxIdx = 0;

void dfplayer_send_cmd(uint8_t cmd, uint16_t arg) {
    uint8_t buf[10];
    buf[0] = 0x7E;
    buf[1] = 0xFF;
    buf[2] = 0x06;
    buf[3] = cmd;
    buf[4] = 0x00;
    buf[5] = (uint8_t)(arg >> 8);
    buf[6] = (uint8_t)(arg & 0xFF);
    uint16_t checksum = 0 - (buf[1] + buf[2] + buf[3] + buf[4] + buf[5] + buf[6]);
    buf[7] = (uint8_t)(checksum >> 8);
    buf[8] = (uint8_t)(checksum & 0xFF);
    buf[9] = 0xEF;
    dfSerial.write(buf, 10);
}

void playAudio(int trackNumber, unsigned long durationMs, bool autoHangup) {
    if (durationMs == 0) {
        if (trackNumber == AUDIO_CALL_ANSWER) durationMs = audioDuration_001;
        else if (trackNumber == AUDIO_MOTOR_ON) durationMs = audioDuration_006;
        else if (trackNumber == AUDIO_MOTOR_OFF) durationMs = audioDuration_009;
        else durationMs = 5000;
    }

    Serial.print("[DFPlayer] Playing Audio Track: ");
    Serial.print(trackNumber);
    Serial.print(" (Duration: ");
    Serial.print(durationMs);
    Serial.print("ms, AutoHangup: ");
    Serial.print(autoHangup ? "YES" : "NO");
    Serial.println(")");

    dfplayer_send_cmd(0x03, (uint16_t)trackNumber);

    currentPlayingTrack = trackNumber;
    audioStartTime = millis();
    currentAudioDuration = durationMs;
    isAudioPlaying = true;
    hangupAfterAudio = autoHangup;
}

void setAudioVolume(int volume) {
    if (volume < 0) volume = 0;
    if (volume > 30) volume = 30;
    Serial.print("[DFPlayer] Set Volume: ");
    Serial.print(volume);
    Serial.println("/30");
    dfplayer_send_cmd(0x06, (uint16_t)volume);
}

void stopAudio() {
    Serial.println("[DFPlayer] Audio Stopped");
    dfplayer_send_cmd(0x16, 0);
    isAudioPlaying = false;
    hangupAfterAudio = false;
}

void onAudioFinished() {
    Serial.print("[DFPlayer] Audio finished for track ");
    Serial.println(currentPlayingTrack);

    if (inCall && hangupAfterAudio) {
        Serial.println("[SIM800L] Audio completed for full length. Hanging up call now...");
        delay(400);
        Serial2.println("ATH"); // Hang up call
        inCall = false;
        hangupAfterAudio = false;
        stopAudio();
    }
}

void handleDFPlayer() {
    // 1. Non-blocking hardware feedback from DFPlayer TX (ESP32 RX=14)
    while (dfSerial.available() > 0) {
        uint8_t b = dfSerial.read();
        if (dfRxIdx == 0) {
            if (b == 0x7E) dfRxBuf[dfRxIdx++] = b;
        } else {
            dfRxBuf[dfRxIdx++] = b;
            if (dfRxIdx == 10) {
                if (dfRxBuf[9] == 0xEF) {
                    uint8_t cmd = dfRxBuf[3];
                    uint16_t track = ((uint16_t)dfRxBuf[5] << 8) | dfRxBuf[6];
                    if (cmd == 0x3D || cmd == 0x3C || cmd == 0x3E) {
                        Serial.print("[DFPlayer] Hardware Feedback: Track finished -> ");
                        Serial.println(track);
                        if (isAudioPlaying) {
                            isAudioPlaying = false;
                            onAudioFinished();
                        }
                    }
                }
                dfRxIdx = 0;
            }
        }
    }

    // 2. Audio duration timer check (Ensures playback takes full audio length)
    if (isAudioPlaying) {
        if (millis() - audioStartTime >= currentAudioDuration) {
            Serial.print("[DFPlayer] Audio track completed by duration timer (");
            Serial.print(currentAudioDuration);
            Serial.println("ms)");
            isAudioPlaying = false;
            onAudioFinished();
        }
    }
}

void initDFPlayer() {
    Serial.println("[DFPlayer] Initializing on RX=14, TX=27 at 9600 baud...");
    dfSerial.begin(DFPLAYER_BAUD, SERIAL_8N1, DFPLAYER_RX_PIN, DFPLAYER_TX_PIN);
    delay(200);
    setAudioVolume(28); // Set volume (0-30)
}

// --- SIM800L HELPER FUNCTIONS ---

void saveAdminPhones() {
    String combined = "";
    for (int i = 0; i < adminPhoneCount; i++) {
        if (i > 0) combined += ",";
        combined += adminPhones[i];
    }
    prefs.begin("sim_cfg", false);
    prefs.putString("phones", combined);
    prefs.end();
    Serial.println("[NVS] Saved Admin Phones (" + String(adminPhoneCount) + "/5): " + combined);
}

void loadAdminPhones() {
    prefs.begin("sim_cfg", true);
    String combined = prefs.getString("phones", "");
    if (combined.length() == 0) {
        String legacy = prefs.getString("admin_phone", "");
        if (legacy.length() > 0) combined = legacy;
    }
    prefs.end();

    adminPhoneCount = 0;
    int start = 0;
    while (start < combined.length() && adminPhoneCount < MAX_ADMIN_PHONES) {
        int comma = combined.indexOf(',', start);
        String p = (comma == -1) ? combined.substring(start) : combined.substring(start, comma);
        p.trim();
        if (p.length() >= 10) {
            adminPhones[adminPhoneCount++] = p;
        }
        if (comma == -1) break;
        start = comma + 1;
    }
    Serial.println("[NVS] Loaded " + String(adminPhoneCount) + " Admin Phones.");
}

bool addAdminPhone(String newPhone) {
    newPhone.trim();
    if (newPhone.length() < 10 || adminPhoneCount >= MAX_ADMIN_PHONES) return false;
    for (int i = 0; i < adminPhoneCount; i++) {
        if (adminPhones[i] == newPhone) return false;
    }
    adminPhones[adminPhoneCount++] = newPhone;
    saveAdminPhones();
    sendPhoneListWS();
    return true;
}

bool removeAdminPhone(String phoneToRemove) {
    phoneToRemove.trim();
    int foundIdx = -1;
    for (int i = 0; i < adminPhoneCount; i++) {
        if (adminPhones[i] == phoneToRemove) {
            foundIdx = i;
            break;
        }
    }
    if (foundIdx != -1) {
        for (int i = foundIdx; i < adminPhoneCount - 1; i++) {
            adminPhones[i] = adminPhones[i + 1];
        }
        adminPhoneCount--;
        saveAdminPhones();
        sendPhoneListWS();
        return true;
    }
    return false;
}

bool isAuthorizedNumber(String incomingNum) {
    if (adminPhoneCount == 0) return false;
    String cleanIncoming = "";
    for (size_t i = 0; i < incomingNum.length(); i++) {
        if (isDigit(incomingNum[i])) cleanIncoming += incomingNum[i];
    }
    if (cleanIncoming.length() < 10) return false;
    String incomingSuffix = cleanIncoming.substring(cleanIncoming.length() - 10);

    for (int j = 0; j < adminPhoneCount; j++) {
        String cleanAdmin = "";
        for (size_t i = 0; i < adminPhones[j].length(); i++) {
            if (isDigit(adminPhones[j][i])) cleanAdmin += adminPhones[j][i];
        }
        if (cleanAdmin.length() >= 10) {
            String adminSuffix = cleanAdmin.substring(cleanAdmin.length() - 10);
            if (adminSuffix == incomingSuffix) return true;
        } else if (cleanAdmin == cleanIncoming) {
            return true;
        }
    }
    return false;
}

void sendPhoneListWS() {
    if (!webSocket.isConnected()) return;
    JsonDocument doc;
    doc["type"] = "phoneListUpdate";
    JsonArray arr = doc["payload"].to<JsonArray>();
    for (int i = 0; i < adminPhoneCount; i++) {
        arr.add(adminPhones[i]);
    }
    String out;
    serializeJson(doc, out);
    webSocket.sendTXT(out);
}

String decodeUSSD(String raw) {
    if (raw.length() >= 4 && (raw.length() % 4 == 0)) {
        bool isHex = true;
        for (size_t i = 0; i < raw.length(); i++) {
            if (!isxdigit(raw[i])) { isHex = false; break; }
        }
        if (isHex) {
            String decoded = "";
            for (size_t i = 0; i < raw.length(); i += 4) {
                String hexByte = raw.substring(i + 2, i + 4);
                char ch = (char) strtol(hexByte.c_str(), NULL, 16);
                if (ch >= 32 && ch <= 126) decoded += ch;
                else if (ch == '\n' || ch == '\r') decoded += '\n';
            }
            if (decoded.length() > 0) return decoded;
        }
    }
    return raw;
}

void dialUSSD(String code) {
    code.trim();
    if (code.length() == 0) return;
    currentUSSDCode = code;
    waitingForUSSD = true;
    ussdStartTime = millis();

    Serial.println("[SIM800L] Dialing USSD: " + code);
    deviceLastAction = "Dialing USSD: " + code;
    Serial2.println("AT+CSCS=\"GSM\"");
    delay(100);
    Serial2.print("AT+CUSD=1,\"");
    Serial2.print(code);
    Serial2.println("\",15");
}

void sendSMS(String number, String message) {
    if (number.length() == 0) return;
    Serial.println("[SIM800L] Sending SMS to " + number + ": " + message);
    Serial2.println("AT+CMGF=1");
    delay(100);
    Serial2.print("AT+CMGS=\"");
    Serial2.print(number);
    Serial2.println("\"");
    delay(200);
    Serial2.print(message);
    delay(100);
    Serial2.write(26); // ASCII 26 (Ctrl+Z) to send
    delay(300);
}

void initSIM800() {
    Serial.println("[SIM800L] Initializing Serial2 on RX=16, TX=17 at 9600 baud...");
    Serial2.begin(SIM800_BAUD, SERIAL_8N1, SIM800_RX_PIN, SIM800_TX_PIN);
    delay(500);
    Serial2.println("AT");
    delay(150);
    Serial2.println("ATE0"); // Disable echo
    delay(150);
    Serial2.println("AT+CMGF=1"); // SMS Text mode
    delay(150);
    Serial2.println("AT+CNMI=1,2,0,0,0"); // Direct SMS output to serial
    delay(150);
    Serial2.println("AT+CLIP=1"); // Enable Caller ID
    delay(150);
    Serial2.println("AT+DDET=1"); // Enable DTMF tone detection
    delay(150);
    Serial.println("[SIM800L] Module Ready.");
}

void handleIncomingSMS(String sender, String text) {
    Serial.println("[SIM800L] SMS from [" + sender + "]: " + text);

    // Command to add authorized number via SMS (e.g. ADD:01712345678)
    if (text.startsWith("ADD:") || text.startsWith("SET:") || text.startsWith("SETNUM:")) {
        int colon = text.indexOf(':');
        String newPhone = text.substring(colon + 1);
        newPhone.trim();
        if (newPhone.length() >= 10) {
            if (addAdminPhone(newPhone)) {
                sendSMS(sender, "Number added (" + String(adminPhoneCount) + "/5): " + newPhone);
            } else {
                sendSMS(sender, "Failed. List full (max 5) or duplicate.");
            }
        } else {
            sendSMS(sender, "Invalid number. Format: ADD:01xxxxxxxxx");
        }
        return;
    }

    // Command to delete number via SMS (e.g. DEL:01712345678)
    if (text.startsWith("DEL:") || text.startsWith("REMOVE:")) {
        int colon = text.indexOf(':');
        String remPhone = text.substring(colon + 1);
        remPhone.trim();
        if (removeAdminPhone(remPhone)) {
            sendSMS(sender, "Number removed: " + remPhone);
        } else {
            sendSMS(sender, "Number not found in list.");
        }
        return;
    }

    // Verify authorized sender for control commands
    if (!isAuthorizedNumber(sender)) {
        Serial.println("[SIM800L] Ignored SMS from unauthorized sender: " + sender);
        return;
    }

    // Command to change system password via SMS (e.g. PASS:1234, PASSWORD:1234, RESET:1234)
    if (text.startsWith("PASS:") || text.startsWith("PASSWORD:") || text.startsWith("SETPASS:") || text.startsWith("RESET:")) {
        int colon = text.indexOf(':');
        String newPass = text.substring(colon + 1);
        newPass.trim();
        if (newPass.length() >= 3) {
            if (webSocket.isConnected()) {
                JsonDocument doc;
                doc["type"] = "command";
                doc["command"] = "SET_PASSWORD_FROM_SMS";
                doc["phone"] = sender;
                doc["value"] = newPass;
                String out;
                serializeJson(doc, out);
                webSocket.sendTXT(out);
            }
            sendSMS(sender, "System password successfully updated to: " + newPass);
            beep();
            deviceLastAction = "Password changed (SMS)";
        } else {
            sendSMS(sender, "Password must be at least 3 characters. Example: PASS:5678");
        }
        return;
    }

    if (text == "LIST") {
        String listMsg = "Authorized (" + String(adminPhoneCount) + "/5):\n";
        for (int i = 0; i < adminPhoneCount; i++) {
            listMsg += String(i + 1) + ". " + adminPhones[i] + "\n";
        }
        sendSMS(sender, listMsg);
    } else if (text == "ON" || text.indexOf("MOTOR ON") != -1) {
        Serial.println("[SIM800L] SMS Triggered: Motor ON");
        digitalWrite(RELAY_1, HIGH);
        relay1_timer = millis();
        beep();
        deviceLastAction = "Motor ON (SMS)";
        lastStatusUpdate = 0;
        sendSMS(sender, "Motor has been turned ON.");
        playAudio(AUDIO_MOTOR_ON);
    } else if (text == "OFF" || text.indexOf("MOTOR OFF") != -1) {
        Serial.println("[SIM800L] SMS Triggered: Motor OFF");
        digitalWrite(RELAY_2, HIGH);
        relay2_timer = millis();
        beep();
        deviceLastAction = "Motor OFF (SMS)";
        lastStatusUpdate = 0;
        sendSMS(sender, "Motor has been turned OFF.");
        playAudio(AUDIO_MOTOR_OFF);
    } else if (text == "STATUS" || text.indexOf("STATUS") != -1) {
        String currentMode = (digitalRead(SWITCH_2) == LOW) ? "Normal" : "Emergency";
        String statusMsg = "Motor: " + stableMotorState + "\nMode: " + currentMode + "\nWiFi: " + (WiFi.status() == WL_CONNECTED ? "Connected" : "Offline");
        sendSMS(sender, statusMsg);
    }
}

void processSIMLine(String line) {
    line.trim();
    if (line.length() == 0) return;
    Serial.println("[SIM800L] " + line);

    // 1. Incoming Call (+CLIP)
    if (line.startsWith("+CLIP:")) {
        int firstQuote = line.indexOf('"');
        int secondQuote = line.indexOf('"', firstQuote + 1);
        if (firstQuote != -1 && secondQuote != -1) {
            String callerNumber = line.substring(firstQuote + 1, secondQuote);
            Serial.println("[SIM800L] Incoming Call from: " + callerNumber);

            if (isAuthorizedNumber(callerNumber)) {
                Serial.println("[SIM800L] Authorized Caller! Answering call...");
                delay(800);
                Serial2.println("ATA"); // Answer call
                delay(300);
                Serial2.println("AT+DDET=1"); // Enable DTMF detection
                inCall = true;
                callStartTime = millis();

                // Call Received: Play greeting/prompt audio (001.mp3)
                // Audio length অনুযায়ী সময় নিয়ে play হবে
                delay(400); // Allow call audio path to connect
                playAudio(AUDIO_CALL_ANSWER, audioDuration_001, false);
            } else {
                Serial.println("[SIM800L] Unauthorized Caller. Rejecting...");
                Serial2.println("ATH"); // Reject call
            }
        }
    }
    // 2. DTMF Tone Detection (+DTMF: 1 or +DTMF: 2)
    else if (line.startsWith("+DTMF:")) {
        int colon = line.indexOf(':');
        if (colon != -1) {
            String keyStr = line.substring(colon + 1);
            keyStr.trim();
            if (keyStr.length() > 0) {
                char key = keyStr.charAt(0);
                Serial.println("[SIM800L] DTMF Received: " + String(key));

                if (key == '1') {
                    Serial.println("[SIM800L] DTMF 1: Turning Motor ON");
                    digitalWrite(RELAY_1, HIGH);
                    relay1_timer = millis();
                    beep();
                    deviceLastAction = "Motor ON (Call/DTMF)";
                    lastStatusUpdate = 0;
                    // Audio 006 length অনুযায়ী সময় নিয়ে প্লে হবে, তারপর কল কেটে যাবে
                    playAudio(AUDIO_MOTOR_ON, audioDuration_006, true);
                } else if (key == '2') {
                    Serial.println("[SIM800L] DTMF 2: Turning Motor OFF");
                    digitalWrite(RELAY_2, HIGH);
                    relay2_timer = millis();
                    beep();
                    deviceLastAction = "Motor OFF (Call/DTMF)";
                    lastStatusUpdate = 0;
                    // Audio 009 length অনুযায়ী সময় নিয়ে প্লে হবে, তারপর কল কেটে যাবে
                    playAudio(AUDIO_MOTOR_OFF, audioDuration_009, true);
                }
            }
        }
    }
    // 3. Call Ended
    else if (line.indexOf("NO CARRIER") != -1 || line.indexOf("BUSY") != -1 || line.indexOf("DISCONNECT") != -1) {
        Serial.println("[SIM800L] Call ended.");
        inCall = false;
        hangupAfterAudio = false;
        stopAudio();
    }
    // 4. Incoming SMS (+CMT)
    else if (line.startsWith("+CMT:")) {
        int firstQuote = line.indexOf('"');
        int secondQuote = line.indexOf('"', firstQuote + 1);
        if (firstQuote != -1 && secondQuote != -1) {
            smsSenderNumber = line.substring(firstQuote + 1, secondQuote);
            isNextLineSMSBody = true;
        }
    }
    // 5. SMS Body Line
    else if (isNextLineSMSBody) {
        isNextLineSMSBody = false;
        String body = line;
        body.trim();
        body.toUpperCase();
        handleIncomingSMS(smsSenderNumber, body);
    }
    // 6. USSD Response (+CUSD)
    else if (line.startsWith("+CUSD:")) {
        Serial.println("[SIM800L] USSD Response Line: " + line);
        waitingForUSSD = false;

        String ussdMsg = "";
        int firstQuote = line.indexOf('"');
        int lastQuote = line.lastIndexOf('"');
        if (firstQuote != -1 && lastQuote > firstQuote) {
            ussdMsg = line.substring(firstQuote + 1, lastQuote);
        } else {
            ussdMsg = line;
        }

        ussdMsg = decodeUSSD(ussdMsg);
        Serial.println("[SIM800L] Decoded USSD: " + ussdMsg);
        deviceLastAction = "USSD Received";

        if (webSocket.isConnected()) {
            JsonDocument resDoc;
            resDoc["type"] = "ussdResponse";
            resDoc["code"] = currentUSSDCode;
            resDoc["message"] = ussdMsg;
            resDoc["status"] = "success";
            String out;
            serializeJson(resDoc, out);
            webSocket.sendTXT(out);
        }
    }
}

void handleSIM800() {
    // Safety auto-hangup if call exceeds maxCallDuration
    if (inCall && (millis() - callStartTime > maxCallDuration)) {
        Serial.println("[SIM800L] Call limit reached. Hanging up...");
        Serial2.println("ATH");
        inCall = false;
        hangupAfterAudio = false;
        stopAudio();
    }

    // Safety timeout for USSD (20 seconds)
    if (waitingForUSSD && (millis() - ussdStartTime > 20000)) {
        waitingForUSSD = false;
        Serial.println("[SIM800L] USSD timeout.");
        Serial2.println("AT+CUSD=2"); // Terminate session
        if (webSocket.isConnected()) {
            JsonDocument resDoc;
            resDoc["type"] = "ussdResponse";
            resDoc["code"] = currentUSSDCode;
            resDoc["message"] = "Network timeout. No response received from operator.";
            resDoc["status"] = "timeout";
            String out;
            serializeJson(resDoc, out);
            webSocket.sendTXT(out);
        }
    }

    // Read Serial2 incoming characters
    while (Serial2.available()) {
        char c = (char)Serial2.read();
        if (c == '\r') continue;
        if (c == '\n') {
            if (simBuffer.length() > 0) {
                processSIMLine(simBuffer);
                simBuffer = "";
            }
        } else {
            simBuffer += c;
            if (simBuffer.length() > 250) simBuffer = "";
        }
    }
}

void tick() {
  // Toggle LED state
  int state = digitalRead(LED_PIN);
  digitalWrite(LED_PIN, !state);
}

// Callback when entering AP Mode
void configModeCallback(WiFiManager *myWiFiManager) {
  Serial.println("Entered config mode");
  Serial.println(WiFi.softAPIP());
  // Start blinking LED every 0.3 seconds
  blinker.attach(0.3, tick);

  if (displayFound) {
      display.clearDisplay();
      display.setTextColor(WHITE);
      display.setTextSize(1);
      display.setCursor(20, 0);
      display.println("WiFi Setup Mode");
      display.drawLine(0, 10, 128, 10, WHITE);
      display.setCursor(0, 20);
      display.println("Connect to WiFi:");
      display.setCursor(0, 35);
      display.setTextSize(2);
      display.print("Mutho-Sech");
      display.setTextSize(1);
      display.setCursor(0, 55);
      display.print("192.168.4.1");
      display.display();
  }
}

void setup() {
    Serial.begin(115200);
    delay(1000); // Wait for Serial
    
    Wire.begin(22, 21); // SDA = 22, SCL = 21
    if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { 
      Serial.println(F("SSD1306 allocation failed. Operating without display."));
      displayFound = false;
    } else {
      displayFound = true;
    }
    
    // Initialize Pins
    pinMode(RELAY_1, OUTPUT); digitalWrite(RELAY_1, LOW);
    pinMode(RELAY_2, OUTPUT); digitalWrite(RELAY_2, LOW);
    pinMode(BUZZER_PIN, OUTPUT); digitalWrite(BUZZER_PIN, LOW);
    pinMode(SWITCH_1, INPUT_PULLUP);
    pinMode(SWITCH_2, INPUT_PULLUP);
    
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW); // Start LOW

    // Initialize SIM800L and Load Stored Admin Phones
    loadAdminPhones();
    initSIM800();
    initDFPlayer();

    // Watchdog Setup
    esp_task_wdt_deinit();
    esp_task_wdt_config_t wdt_config = {
        .timeout_ms = WDT_TIMEOUT * 1000,
        .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
        .trigger_panic = true
    };
    esp_task_wdt_init(&wdt_config);

    // --- STANDARD NVS INIT START ---
    
    // 1. Initialize NVS
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
      Serial.println("NVS Corruption Detected. Erasing...");
      ESP_ERROR_CHECK(nvs_flash_erase());
      ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // 2. WiFiManager Setup
    WiFi.setAutoReconnect(true);
    WiFi.persistent(true);
    
    WiFiManager wm;
    // wm.resetSettings(); // COMMENTED OUT: Settings will now be saved!
    wm.setAPCallback(configModeCallback); // Set Blink Callback
    wm.setConfigPortalTimeout(180); // 3 Minutes timeout

    if (displayFound) {
      display.clearDisplay();
      display.setTextSize(1);
      display.setCursor(0, 25);
      display.println("Attempting Connection");
      display.setCursor(0, 40);
      display.println("Wait...");
      display.display();
    }

    // --- STANDARD NVS INIT END ---

    if (!wm.autoConnect("Mutho-Sech")) {
        Serial.println("Failed to connect. Restarting...");
        delay(3000);
        ESP.restart();
    }

    // Connected!
    blinker.detach(); // Stop blinking
    digitalWrite(LED_PIN, HIGH); // Turn LED ON (Solid)
    beep(); // Confirm connection with beep

    Serial.println("WiFi Connected!");
    Serial.println("Current Version: " + String(currentFirmwareVersion));

    // Check for update ONCE at startup
    
    // Enable WDT monitoring for this task NOW, BEFORE OTA check
    // This prevents "task not found" error during OTA write
    esp_task_wdt_add(NULL);

    checkForFirmwareUpdate();
    
    // WebSocket Setup
    webSocket.beginSSL(websocket_server_host, websocket_server_port, "/");
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(5000);
}

void loop() {
    esp_task_wdt_reset(); // Keep device alive
    webSocket.loop();
    handleSIM800();   // SIM800L Non-blocking Call, SMS & DTMF handler
    handleDFPlayer(); // DFPlayer Non-blocking Audio Length & Playback handler

    // FIXED: Smart Reconnect Logic
    // এটি প্রতি ১০ সেকেন্ডে চেক করবে কানেকশন আছে কিনা। না থাকলে রিকানেক্ট করবে।
    // এটি লুপ আটকে রাখবে না।
    if (millis() - lastWifiCheck > wifiCheckInterval) {
        lastWifiCheck = millis();
        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("WiFi Lost! Attempting reconnect...");
            WiFi.reconnect(); // DO NOT USE disconnect() here
        }
    }

    // Handle Relay Timers (Non-blocking)
    unsigned long currentMillis = millis();
    if (relay1_timer > 0 && currentMillis - relay1_timer >= relay_duration) {
        digitalWrite(RELAY_1, LOW); relay1_timer = 0;
    }
    if (relay2_timer > 0 && currentMillis - relay2_timer >= relay_duration) {
        digitalWrite(RELAY_2, LOW); relay2_timer = 0;
    }
    if (buzzer_timer > 0 && currentMillis - buzzer_timer >= buzzer_duration) {
        digitalWrite(BUZZER_PIN, LOW); buzzer_timer = 0;
    }

    // Check Status and Send Update
    sendStatus();
    
    // Update the OLED Screen
    updateDisplay();
}

void updateDisplay() {
    if (!displayFound) return;
    if ((millis() - lastDisplayUpdate) < displayUpdateInterval) return;
    lastDisplayUpdate = millis();
    displayBlink = !displayBlink;

    display.clearDisplay();
    display.setTextColor(WHITE);

    // Header: WiFi & Signal
    display.setTextSize(1);
    display.setCursor(0, 0);
    if (WiFi.status() == WL_CONNECTED) {
        int sig = constrain(map(WiFi.RSSI(), -100, -30, 0, 100), 0, 100);
        display.print("W:"); display.print(sig); display.print("% ");
        // Show just the last octet of IP if it's too long
        display.print("IP:..."); display.print(WiFi.localIP()[3]); 
    } else {
        display.print("WiFi: ---");
    }
    
    // Blinking Activity Dot
    display.setCursor(120, 0);
    if (displayBlink) display.print("*");
    
    display.drawLine(0, 10, 128, 10, WHITE);
    
    // Row 2: Server Status
    display.setCursor(0, 14);
    if (isServerConnected) {
        display.print("Server: Connected");
    } else {
        display.print("Server: Offline");
    }
    
    // Body: Motor Status
    display.setCursor(0, 26);
    display.setTextSize(1);
    display.print("MTR:");
    
    display.setTextSize(2);
    display.setCursor(40, 24);
    if (stableMotorState == "ON") {
        display.fillRect(38, 22, 34, 18, WHITE);
        display.setTextColor(BLACK, WHITE);
        display.print("ON");
        display.setTextColor(WHITE, BLACK);
    } else {
        display.print("OFF");
    }

    // Body: System Mode
    display.setTextSize(1);
    display.setCursor(0, 44);
    String modeToPrint = (digitalRead(SWITCH_2) == LOW) ? "Normal" : "Emergency";
    display.print("Mode: ");
    display.print(modeToPrint);
    
    display.drawLine(0, 53, 128, 53, WHITE);

    // Footer: Last Action (Truncated to fit screen)
    display.setCursor(0, 56);
    display.print(deviceLastAction.substring(0, 21)); 

    display.display();
}

bool isNewerVersion(String current, String latest) {
    // Simple SemVer comparison (e.g. 1.1.3 vs 1.1.5)
    // Returns true if latest > current
    int c_major = 0, c_minor = 0, c_patch = 0;
    int l_major = 0, l_minor = 0, l_patch = 0;
    
    sscanf(current.c_str(), "%d.%d.%d", &c_major, &c_minor, &c_patch);
    sscanf(latest.c_str(), "%d.%d.%d", &l_major, &l_minor, &l_patch);
    
    if (l_major > c_major) return true;
    if (l_major < c_major) return false;
    
    if (l_minor > c_minor) return true;
    if (l_minor < c_minor) return false;
    
    if (l_patch > c_patch) return true;
    
    return false;
}

void checkForFirmwareUpdate() {
  Serial.println("Checking for firmware update...");
  if (WiFi.status() != WL_CONNECTED) return;

  // Step 1: Fetch the latest version
  String latestVersion = fetchLatestVersion();
  // Remove trailing dots if any (User error protection)
  while (latestVersion.endsWith(".")) latestVersion.remove(latestVersion.length()-1);
  
  if (latestVersion == "") {
    Serial.println("Failed to fetch latest version");
    return;
  }

  Serial.println("Current: " + String(currentFirmwareVersion));
  Serial.println("Latest: " + latestVersion);

  // Step 2: Compare versions properly
  if (isNewerVersion(String(currentFirmwareVersion), latestVersion)) {
    Serial.println("New firmware available. Starting OTA update...");
    esp_task_wdt_reset(); // Reset WDT before heavy task
    downloadAndApplyFirmware();
  } else {
    Serial.println("Device is up to date (or newer).");
  }
}

String fetchLatestVersion() {
  HTTPClient http;
  http.setTimeout(10000); // 10s Timeout
  http.begin(versionUrl);

  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    String latestVersion = http.getString();
    latestVersion.trim();
    http.end();
    return latestVersion;
  } else {
    Serial.printf("Failed to fetch version. HTTP code: %d\n", httpCode);
    http.end();
    return "";
  }
}

void downloadAndApplyFirmware() {
  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setTimeout(15000); 
  http.begin(firmwareUrl);

  int httpCode = http.GET();
  Serial.printf("HTTP GET code: %d\n", httpCode);

  if (httpCode == HTTP_CODE_OK) {
    int contentLength = http.getSize();
    Serial.printf("Firmware size: %d bytes\n", contentLength);

    if (contentLength > 0) {
      WiFiClient* stream = http.getStreamPtr();
      if (startOTAUpdate(stream, contentLength)) {
        Serial.println("OTA update successful, restarting...");
        delay(1000);
        ESP.restart();
      } else {
        Serial.println("OTA update failed");
      }
    } else {
      Serial.println("Invalid firmware size");
    }
  } else {
    Serial.printf("Failed to fetch firmware. HTTP code: %d\n", httpCode);
  }
  http.end();
}

bool startOTAUpdate(WiFiClient* client, int contentLength) {
  Serial.println("Initializing update...");
  if (!Update.begin(contentLength)) {
    Serial.printf("Update begin failed: %s\n", Update.errorString());
    return false;
  }

  Serial.println("Writing firmware...");
  size_t written = 0;
  int progress = 0;
  int lastProgress = 0;

  const unsigned long timeoutDuration = 120 * 1000; // 2 Minutes
  unsigned long lastDataTime = millis();

  while (written < contentLength) {
    esp_task_wdt_reset(); // CRITICAL: Prevent Watchdog Reset during OTA

    if (client->available()) {
      uint8_t buffer[256];
      size_t len = client->read(buffer, sizeof(buffer));
      if (len > 0) {
        Update.write(buffer, len);
        written += len;
        
        lastDataTime = millis(); // Reset timeout on data

        // Calculate and print progress
        progress = (written * 100) / contentLength;
        if (progress != lastProgress) {
          Serial.printf("Progress: %d%%\n", progress);
          lastProgress = progress;
        }
      }
    }
    
    // Check for timeout
    if (millis() - lastDataTime > timeoutDuration) {
      Serial.println("Error: Connection timed out during update.");
      Update.abort();
      return false;
    }

    yield();
  }

  if (written != contentLength) {
    Serial.printf("Error: Write incomplete. Exp: %d, Got: %d\n", contentLength, written);
    Update.abort();
    return false;
  }

  if (!Update.end()) {
    Serial.printf("Error: Update end failed: %s\n", Update.errorString());
    return false;
  }

  return true;
}