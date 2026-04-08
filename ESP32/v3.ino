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
const char* websocket_server_host = "mypumpv8.onrender.com";
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
#define SWITCH_1 23
#define SWITCH_2 19 // Moved from 22 to 19 to fix I2C (SDA/SCL) pin conflict

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
                } else if (command == "RELAY_2" || command == "RELAY_2_AUTO") {
                    digitalWrite(RELAY_2, HIGH);
                    relay2_timer = millis();
                    beep();
                    if (command == "RELAY_2_AUTO") deviceLastAction = "Motor OFF (Auto)";
                    else deviceLastAction = "Motor OFF (Remote)";
                } else if (command == "RESET") {
                    beep();
                    deviceLastAction = "System Reset";
                } else if (command == "RESTART_ESP") {
                    webSocket.disconnect();
                    delay(500);
                    ESP.restart();
                } else if (command == "CHECK_UPDATE") {
                    checkForFirmwareUpdate();
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