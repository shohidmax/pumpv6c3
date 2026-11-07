import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  StatusBar,
  ActivityIndicator,
  Alert,
  Modal,
  Switch,
  RefreshControl,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DEFAULT_HTTP_SERVER = 'https://pvrv3.maxapi.esp32.site';
const DEFAULT_WS_SERVER = 'wss://pvrv3.maxapi.esp32.site';

export default function App() {
  // App Config & Auth State
  const [serverUrl, setServerUrl] = useState(DEFAULT_HTTP_SERVER);
  const [wsUrl, setWsUrl] = useState(DEFAULT_WS_SERVER);
  const [authToken, setAuthToken] = useState(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);

  // Login Form
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [customServerInput, setCustomServerInput] = useState(DEFAULT_HTTP_SERVER);

  // Active Tab: 'control' | 'gsm' | 'logs' | 'settings'
  const [activeTab, setActiveTab] = useState('control');

  // Live Device & WebSocket States
  const [wsConnected, setWsConnected] = useState(false);
  const [espOnline, setEspOnline] = useState(false);
  const [motorStatus, setMotorStatus] = useState('OFF');
  const [systemMode, setSystemMode] = useState('Normal');
  const [wifiSignal, setWifiSignal] = useState(0);
  const [localIP, setLocalIP] = useState('--');
  const [firmwareVersion, setFirmwareVersion] = useState('1.1.9');
  const [lastAction, setLastAction] = useState('Initializing...');
  const [isAlwaysOn, setIsAlwaysOn] = useState(false);

  // GSM Phone List
  const [adminPhones, setAdminPhones] = useState([]);
  const [newPhoneInput, setNewPhoneInput] = useState('');
  const [isAddingPhone, setIsAddingPhone] = useState(false);

  // USSD State
  const [ussdInput, setUssdInput] = useState('*566#');
  const [isDialingUssd, setIsDialingUssd] = useState(false);
  const [ussdResponse, setUssdResponse] = useState('');
  const [ussdResponseCode, setUssdResponseCode] = useState('');
  const [quickUssds, setQuickUssds] = useState([
    { id: '1', code: '*566#', label: 'GP' },
    { id: '2', code: '*121#', label: 'BL/Robi' },
    { id: '3', code: '*222#', label: 'Robi/Air' },
    { id: '4', code: '*152#', label: 'Teletalk' },
  ]);

  // History Logs & Schedules
  const [schedules, setSchedules] = useState([]);
  const [motorLogs, setMotorLogs] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  // Change Password Modal
  const [changePwdVisible, setChangePwdVisible] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changePwdLoading, setChangePwdLoading] = useState(false);

  // Action Confirmation Modal
  const [confirmModalVisible, setConfirmModalVisible] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  // 1. Initial Load: Check Auth
  useEffect(() => {
    checkStoredAuth();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, []);

  const checkStoredAuth = async () => {
    try {
      const savedHttp = await AsyncStorage.getItem('server_http_url');
      const savedWs = await AsyncStorage.getItem('server_ws_url');
      const savedToken = await AsyncStorage.getItem('motor_token');

      const activeHttp = savedHttp || DEFAULT_HTTP_SERVER;
      const activeWs = savedWs || DEFAULT_WS_SERVER;

      setServerUrl(activeHttp);
      setWsUrl(activeWs);
      setCustomServerInput(activeHttp);

      if (savedToken) {
        // Verify token with server
        try {
          const res = await fetch(`${activeHttp}/api/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: savedToken }),
          });
          const data = await res.json();
          if (data && data.valid) {
            setAuthToken(savedToken);
            connectWebSocket(activeWs, savedToken);
          } else {
            await AsyncStorage.removeItem('motor_token');
          }
        } catch (e) {
          // If network error, still try to use saved token
          setAuthToken(savedToken);
          connectWebSocket(activeWs, savedToken);
        }
      }
    } catch (err) {
      console.log('Error checking stored auth:', err);
    } finally {
      setIsLoadingAuth(false);
    }
  };

  // 2. WebSocket Connection Management
  const connectWebSocket = (wsEndpoint, token) => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {}
    }

    const targetUrl = wsEndpoint || wsUrl;
    const activeTok = token || authToken;

    console.log('[WS] Connecting to:', targetUrl);
    try {
      const socket = new WebSocket(targetUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        console.log('[WS] Connected successfully');
        setWsConnected(true);
        // Identify as Web Client
        socket.send(
          JSON.stringify({
            type: 'web-identify',
            token: activeTok,
          })
        );
        // Request initial data
        sendWsCommand('GET_ALWAYS_ON', null, socket);
        sendWsCommand('GET_SCHEDULES', null, socket);
        sendWsCommand('GET_PHONES', null, socket);
        sendWsCommand('GET_QUICK_USSD', null, socket);
        sendWsCommand('GET_LOG_PAGE', 0, socket);
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data.trim());
          handleIncomingMessage(data);
        } catch (e) {
          console.log('[WS] Parse error:', e);
        }
      };

      socket.onclose = () => {
        console.log('[WS] Disconnected');
        setWsConnected(false);
        setEspOnline(false);
        // Auto-reconnect if authenticated
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          if (authToken) {
            connectWebSocket(targetUrl, activeTok);
          }
        }, 3000);
      };

      socket.onerror = (err) => {
        console.log('[WS] Error:', err);
        socket.close();
      };
    } catch (err) {
      console.log('[WS] Connection exception:', err);
    }
  };

  const handleIncomingMessage = (data) => {
    switch (data.type) {
      case 'statusUpdate':
        if (data.payload) {
          if (data.payload.motorStatus !== undefined) setMotorStatus(data.payload.motorStatus);
          if (data.payload.systemMode !== undefined) setSystemMode(data.payload.systemMode);
          if (data.payload.wifiSignal !== undefined) setWifiSignal(data.payload.wifiSignal);
          if (data.payload.localIP !== undefined) setLocalIP(data.payload.localIP);
          if (data.payload.version !== undefined) setFirmwareVersion(data.payload.version);
          if (data.payload.lastAction !== undefined) setLastAction(data.payload.lastAction);
        }
        break;

      case 'espStatus':
        setEspOnline(data.status === 'online');
        break;

      case 'alwaysOnUpdate':
        setIsAlwaysOn(!!data.payload);
        break;

      case 'phoneListUpdate':
      case 'phoneUpdate':
        if (Array.isArray(data.payload)) {
          setAdminPhones(data.payload);
        } else if (data.payload) {
          setAdminPhones([data.payload]);
        }
        break;

      case 'quickUssdUpdate':
        if (Array.isArray(data.payload) && data.payload.length > 0) {
          setQuickUssds(data.payload);
        }
        break;

      case 'ussdResponse':
        setIsDialingUssd(false);
        setUssdResponseCode(data.code || '');
        setUssdResponse(data.message || 'No message received');
        break;

      case 'scheduleUpdate':
        if (Array.isArray(data.payload)) setSchedules(data.payload);
        break;

      case 'logPageUpdate':
        if (data.payload && Array.isArray(data.payload.logs)) {
          setMotorLogs(data.payload.logs);
        }
        break;

      default:
        break;
    }
  };

  const sendWsCommand = (command, value = null, socket = null) => {
    const activeSocket = socket || wsRef.current;
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(
        JSON.stringify({
          type: 'command',
          command,
          value,
          token: authToken,
        })
      );
    } else {
      Alert.alert('অফলাইন', 'সার্ভারের সাথে সংযোগ নেই। অনুগ্রহ করে অপেক্ষা করুন।');
    }
  };

  // 3. Auth Actions
  const handleLogin = async () => {
    if (!loginPassword.trim()) {
      setLoginError('দয়া করে পাসওয়ার্ড লিখুন');
      return;
    }
    setLoginError('');
    setIsLoggingIn(true);

    try {
      const res = await fetch(`${serverUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword.trim() }),
      });
      const data = await res.json();

      if (res.ok && data.success && data.token) {
        await AsyncStorage.setItem('motor_token', data.token);
        setAuthToken(data.token);
        setLoginPassword('');
        connectWebSocket(wsUrl, data.token);
      } else {
        setLoginError(data.message || 'ভুল পাসওয়ার্ড! আবার চেষ্টা করুন।');
      }
    } catch (err) {
      setLoginError('সার্ভারের সাথে কানেক্ট করা যাচ্ছে না। URL যাচাই করুন।');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    Alert.alert('লগআউট', 'আপনি কি নিশ্চিত যে লগআউট করতে চান?', [
      { text: 'বাতিল', style: 'cancel' },
      {
        text: 'লগআউট',
        style: 'destructive',
        onPress: async () => {
          if (authToken) {
            try {
              await fetch(`${serverUrl}/api/logout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: authToken }),
              });
            } catch (e) {}
          }
          await AsyncStorage.removeItem('motor_token');
          setAuthToken(null);
          if (wsRef.current) wsRef.current.close();
        },
      },
    ]);
  };

  const handleSaveCustomServer = async () => {
    let clean = customServerInput.trim();
    if (!clean) return;
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = 'https://' + clean;
    }
    let wsClean = clean.replace('http://', 'ws://').replace('https://', 'wss://');

    setServerUrl(clean);
    setWsUrl(wsClean);
    await AsyncStorage.setItem('server_http_url', clean);
    await AsyncStorage.setItem('server_ws_url', wsClean);
    setShowServerConfig(false);
    Alert.alert('সফল', `সার্ভার URL আপডেট হয়েছে:\n${clean}`);
  };

  const handleChangePassword = async () => {
    if (!oldPassword || !newPassword || !confirmPassword) {
      Alert.alert('ভুল', 'সবগুলো ফিল্ড পূরণ করুন');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('ভুল', 'নতুন পাসওয়ার্ড দুটি মিলছে না!');
      return;
    }
    if (newPassword.length < 3) {
      Alert.alert('ভুল', 'নতুন পাসওয়ার্ড কমপক্ষে ৩ অক্ষরের হতে হবে');
      return;
    }

    setChangePwdLoading(true);
    try {
      const res = await fetch(`${serverUrl}/api/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPassword,
          newPassword,
          token: authToken,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        Alert.alert('সফল', data.message || 'পাসওয়ার্ড সফলভাবে পরিবর্তিত হয়েছে!');
        setChangePwdVisible(false);
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        Alert.alert('ব্যর্থ', data.message || 'পাসওয়ার্ড পরিবর্তন করা যায়নি!');
      }
    } catch (e) {
      Alert.alert('ত্রুটি', 'সার্ভার যোগাযোগে সমস্যা হয়েছে।');
    } finally {
      setChangePwdLoading(false);
    }
  };

  // 4. Motor Actions with Confirmation
  const confirmAction = (command, title, message) => {
    setPendingAction({ command, title, message });
    setConfirmModalVisible(true);
  };

  const executePendingAction = () => {
    if (pendingAction) {
      sendWsCommand(pendingAction.command);
      setConfirmModalVisible(false);
      setPendingAction(null);
    }
  };

  // 5. GSM Number Management
  const handleAddPhone = () => {
    const clean = newPhoneInput.trim();
    if (clean.length < 10) {
      Alert.alert('ভুল', 'সঠিক মোবাইল নম্বর লিখুন (যেমন: 01712345678)');
      return;
    }
    if (adminPhones.length >= 5) {
      Alert.alert('সীমা শেষ', 'সর্বোচ্চ ৫টি নম্বর যুক্ত করা যাবে।');
      return;
    }
    sendWsCommand('ADD_PHONE', clean);
    setNewPhoneInput('');
    setIsAddingPhone(false);
  };

  const handleRemovePhone = (phone) => {
    Alert.alert('মুছে ফেলুন', `আপনি কি ${phone} নম্বরটি মুছে ফেলতে চান?`, [
      { text: 'না', style: 'cancel' },
      {
        text: 'হ্যাঁ, মুছুন',
        style: 'destructive',
        onPress: () => sendWsCommand('REMOVE_PHONE', phone),
      },
    ]);
  };

  // 6. USSD Actions
  const handleDialUssd = (codeToDial) => {
    const code = (codeToDial || ussdInput).trim();
    if (!code) {
      Alert.alert('ভুল', 'ইউএসএসডি কোড লিখুন (যেমন: *566#)');
      return;
    }
    setIsDialingUssd(true);
    setUssdResponse('');
    setUssdResponseCode(code);
    sendWsCommand('DIAL_USSD', code);
  };

  // Pull to refresh
  const onRefresh = () => {
    setRefreshing(true);
    sendWsCommand('GET_ALWAYS_ON');
    sendWsCommand('GET_SCHEDULES');
    sendWsCommand('GET_PHONES');
    sendWsCommand('GET_QUICK_USSD');
    sendWsCommand('GET_LOG_PAGE', 0);
    setTimeout(() => setRefreshing(false), 800);
  };

  // ==========================================
  // RENDER: LOADING VIEW
  // ==========================================
  if (isLoadingAuth) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#0284c7" />
        <Text style={styles.loadingText}>মুঠো-সেচ লোড হচ্ছে...</Text>
      </View>
    );
  }

  // ==========================================
  // RENDER: LOGIN SCREEN (PASSWORD PROTECTED)
  // ==========================================
  if (!authToken) {
    return (
      <SafeAreaView style={styles.loginContainer}>
        <StatusBar barStyle="dark-content" backgroundColor="#f8fafc" />
        <ScrollView contentContainerStyle={styles.loginScroll}>
          {/* Brand Header */}
          <View style={styles.loginHeader}>
            <View style={styles.loginIconBadge}>
              <Text style={styles.loginIconText}>⚡</Text>
            </View>
            <Text style={styles.loginTitle}>মুঠো-সেচ কন্ট্রোলার</Text>
            <Text style={styles.loginSubtitle}>Smart Pump & Motor Controller</Text>
            <Text style={styles.loginInstruction}>
              মোটর কন্ট্রোল প্যানেলে প্রবেশ করতে পাসওয়ার্ড দিন
            </Text>
          </View>

          {/* Login Card */}
          <View style={styles.loginCard}>
            <Text style={styles.inputLabel}>সিস্টেম পাসওয়ার্ড (Password)</Text>
            <View style={styles.passwordInputWrapper}>
              <TextInput
                style={styles.passwordInput}
                placeholder="পাসওয়ার্ড লিখুন..."
                placeholderTextColor="#94a3b8"
                secureTextEntry={!showPassword}
                value={loginPassword}
                onChangeText={setLoginPassword}
                autoCapitalize="none"
              />
              <TouchableOpacity
                style={styles.eyeBtn}
                onPress={() => setShowPassword(!showPassword)}
              >
                <Text style={styles.eyeBtnText}>{showPassword ? '👁️' : '🔒'}</Text>
              </TouchableOpacity>
            </View>

            {loginError ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>⚠️ {loginError}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.loginBtn, isLoggingIn && styles.btnDisabled]}
              onPress={handleLogin}
              disabled={isLoggingIn}
            >
              {isLoggingIn ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.loginBtnText}>লগইন করে প্রবেশ করুন</Text>
              )}
            </TouchableOpacity>

            <View style={styles.defaultPwdNote}>
              <Text style={styles.defaultPwdText}>ডিফল্ট পাসওয়ার্ড: 1234</Text>
            </View>
          </View>

          {/* Server Config Toggle */}
          <TouchableOpacity
            style={styles.serverConfigToggle}
            onPress={() => setShowServerConfig(!showServerConfig)}
          >
            <Text style={styles.serverConfigToggleText}>
              ⚙️ সার্ভার সেটিংস ({serverUrl.replace('https://', '').replace('http://', '')})
            </Text>
          </TouchableOpacity>

          {showServerConfig && (
            <View style={styles.serverConfigBox}>
              <Text style={styles.serverConfigLabel}>সার্ভার URL (HTTP/HTTPS):</Text>
              <TextInput
                style={styles.serverConfigInput}
                value={customServerInput}
                onChangeText={setCustomServerInput}
                placeholder="https://pvrv3.maxapi.esp32.site"
                autoCapitalize="none"
              />
              <TouchableOpacity
                style={styles.saveServerBtn}
                onPress={handleSaveCustomServer}
              >
                <Text style={styles.saveServerBtnText}>URL সেভ করুন</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ==========================================
  // RENDER: MAIN DASHBOARD (AUTHENTICATED)
  // ==========================================
  return (
    <SafeAreaView style={styles.mainContainer}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />

      {/* Top App Bar */}
      <View style={styles.appBar}>
        <View>
          <Text style={styles.appBarTitle}>মুঠো-সেচ</Text>
          <Text style={styles.appBarSubtitle}>v{firmwareVersion} • IP: {localIP}</Text>
        </View>

        <View style={styles.appBarRight}>
          {/* Connection Status Badge */}
          <View
            style={[
              styles.statusBadge,
              espOnline ? styles.badgeSuccess : styles.badgeError,
            ]}
          >
            <View
              style={[
                styles.statusDot,
                { backgroundColor: espOnline ? '#22c55e' : '#ef4444' },
              ]}
            />
            <Text style={styles.statusBadgeText}>
              {espOnline ? `Online (${wifiSignal}%)` : 'Offline'}
            </Text>
          </View>

          {/* Logout Button */}
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
            <Text style={styles.logoutBtnText}>🚪</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Main Content Area */}
      <ScrollView
        style={styles.contentScroll}
        contentContainerStyle={styles.contentPadding}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#0284c7']} />
        }
      >
        {/* ----------------- TAB 1: CONTROL ----------------- */}
        {activeTab === 'control' && (
          <View>
            {/* Big Motor Status Card */}
            <View
              style={[
                styles.motorCard,
                motorStatus === 'ON' ? styles.motorCardRunning : styles.motorCardStopped,
              ]}
            >
              <Text style={styles.motorCardLabel}>বর্তমান মোটর অবস্থা</Text>
              <Text style={styles.motorCardStatus}>
                {motorStatus === 'ON' ? 'MOTOR RUNNING' : 'MOTOR STOPPED'}
              </Text>

              <View style={styles.motorMetaRow}>
                <Text style={styles.motorMetaText}>মোড: {systemMode}</Text>
                <Text style={styles.motorMetaDivider}>•</Text>
                <Text style={styles.motorMetaText}>WiFi: {wifiSignal}%</Text>
              </View>

              <View style={styles.lastActionBox}>
                <Text style={styles.lastActionLabel}>শেষ অ্যাকশন:</Text>
                <Text style={styles.lastActionText} numberOfLines={1}>
                  {lastAction}
                </Text>
              </View>
            </View>

            {/* Quick Control Buttons */}
            <View style={styles.buttonRow}>
              {/* Start Motor Button */}
              <TouchableOpacity
                style={[
                  styles.actionButton,
                  styles.btnStart,
                  !espOnline && styles.btnDisabled,
                ]}
                onPress={() =>
                  confirmAction(
                    'RELAY_1',
                    'মোটর চালু নিশ্চিতকরণ',
                    'আপনি কি মোটর চালু করার জন্য স্টার্ট পালস দিতে চান?'
                  )
                }
                disabled={!espOnline}
              >
                <Text style={styles.actionButtonIcon}>▶️</Text>
                <Text style={styles.actionButtonText}>মোটর চালু (START)</Text>
              </TouchableOpacity>

              {/* Stop Motor Button */}
              <TouchableOpacity
                style={[
                  styles.actionButton,
                  styles.btnStop,
                  !espOnline && styles.btnDisabled,
                ]}
                onPress={() =>
                  confirmAction(
                    'RELAY_2',
                    'মোটর বন্ধ নিশ্চিতকরণ',
                    'আপনি কি মোটর বন্ধ করার জন্য স্টপ পালস দিতে চান?'
                  )
                }
                disabled={!espOnline}
              >
                <Text style={styles.actionButtonIcon}>⏹️</Text>
                <Text style={styles.actionButtonText}>মোটর বন্ধ (STOP)</Text>
              </TouchableOpacity>
            </View>

            {/* Reset Button */}
            <TouchableOpacity
              style={[styles.resetButton, !espOnline && styles.btnDisabled]}
              onPress={() =>
                confirmAction(
                  'RESET',
                  'সিস্টেম রিসেট',
                  'আপনি কি সিস্টেম রিসেট পালস পাঠাতে চান?'
                )
              }
              disabled={!espOnline}
            >
              <Text style={styles.resetButtonText}>🔄 সিস্টেম রিসেট (RESET)</Text>
            </TouchableOpacity>

            {/* Mode & Automation Settings */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>স্বয়ংক্রিয় পাওয়ার এনফোর্সমেন্ট</Text>
              <View style={styles.switchRow}>
                <View style={styles.switchTextCol}>
                  <Text style={styles.switchLabel}>সর্বদা চালু রাখুন (Always ON)</Text>
                  <Text style={styles.switchDescription}>
                    বিদ্যুৎ চলে গিয়ে আবার আসলে স্বয়ংক্রিয়ভাবে মোটর চালু করবে
                  </Text>
                </View>
                <Switch
                  value={isAlwaysOn}
                  onValueChange={(val) => {
                    setIsAlwaysOn(val);
                    sendWsCommand('SET_ALWAYS_ON', val);
                  }}
                  trackColor={{ false: '#cbd5e1', true: '#38bdf8' }}
                  thumbColor={isAlwaysOn ? '#0284c7' : '#f1f5f9'}
                />
              </View>
            </View>
          </View>
        )}

        {/* ----------------- TAB 2: GSM & USSD ----------------- */}
        {activeTab === 'gsm' && (
          <View>
            {/* Authorized Admin Phone Numbers (Max 5) */}
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>
                  অনুমোদিত মোবাইল নম্বর ({adminPhones.length}/5)
                </Text>
                {adminPhones.length < 5 && (
                  <TouchableOpacity
                    style={styles.addSmallBtn}
                    onPress={() => setIsAddingPhone(!isAddingPhone)}
                  >
                    <Text style={styles.addSmallBtnText}>
                      {isAddingPhone ? 'বাতিল' : '+ নতুন নম্বর'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>

              {isAddingPhone && (
                <View style={styles.addPhoneBox}>
                  <TextInput
                    style={styles.phoneInput}
                    placeholder="01xxxxxxxxx"
                    placeholderTextColor="#94a3b8"
                    keyboardType="phone-pad"
                    value={newPhoneInput}
                    onChangeText={setNewPhoneInput}
                  />
                  <TouchableOpacity style={styles.confirmAddBtn} onPress={handleAddPhone}>
                    <Text style={styles.confirmAddBtnText}>যোগ করুন</Text>
                  </TouchableOpacity>
                </View>
              )}

              {adminPhones.length === 0 ? (
                <Text style={styles.emptyNotice}>কোনো নম্বর যুক্ত করা হয়নি।</Text>
              ) : (
                adminPhones.map((phone, idx) => (
                  <View key={idx} style={styles.phoneItemRow}>
                    <View style={styles.phoneItemLeft}>
                      <Text style={styles.phoneBadge}>{idx + 1}</Text>
                      <Text style={styles.phoneNumberText}>{phone}</Text>
                    </View>
                    <TouchableOpacity
                      style={styles.phoneDelBtn}
                      onPress={() => handleRemovePhone(phone)}
                    >
                      <Text style={styles.phoneDelText}>🗑️</Text>
                    </TouchableOpacity>
                  </View>
                ))
              )}
            </View>

            {/* USSD Code Dial Section */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>USSD ডায়াল ও ব্যালেন্স চেক</Text>
              <Text style={styles.sectionDesc}>
                সিম কার্ডের ব্যালেন্স ও অফার জানার জন্য ইউএসএসডি কোড ডায়াল করুন
              </Text>

              {/* Quick USSD Buttons */}
              <View style={styles.quickUssdRow}>
                {quickUssds.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.quickUssdBtn}
                    onPress={() => handleDialUssd(item.code)}
                  >
                    <Text style={styles.quickUssdBtnLabel}>{item.label}</Text>
                    <Text style={styles.quickUssdBtnCode}>{item.code}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Custom Dial Row */}
              <View style={styles.ussdInputRow}>
                <TextInput
                  style={styles.ussdTextInput}
                  placeholder="*566#"
                  value={ussdInput}
                  onChangeText={setUssdInput}
                  autoCapitalize="none"
                />
                <TouchableOpacity
                  style={[styles.ussdDialBtn, isDialingUssd && styles.btnDisabled]}
                  onPress={() => handleDialUssd(ussdInput)}
                  disabled={isDialingUssd}
                >
                  {isDialingUssd ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.ussdDialBtnText}>ডায়াল করুন</Text>
                  )}
                </TouchableOpacity>
              </View>

              {/* USSD Response Box */}
              {ussdResponse ? (
                <View style={styles.ussdResponseCard}>
                  <Text style={styles.ussdResponseHeader}>
                    📩 USSD উত্তর ({ussdResponseCode}):
                  </Text>
                  <Text style={styles.ussdResponseContent}>{ussdResponse}</Text>
                </View>
              ) : null}
            </View>
          </View>
        )}

        {/* ----------------- TAB 3: SCHEDULES & LOGS ----------------- */}
        {activeTab === 'logs' && (
          <View>
            {/* Automation Schedules */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>অটোমেশন শিডিউল তালিকা</Text>
              {schedules.length === 0 ? (
                <Text style={styles.emptyNotice}>কোনো শিডিউল সংরক্ষিত নেই।</Text>
              ) : (
                schedules.map((s, idx) => (
                  <View key={s._id || idx} style={styles.scheduleItem}>
                    <View style={styles.scheduleLeft}>
                      <Text style={styles.scheduleTime}>
                        ⏰ {s.startTime} - {s.endTime}
                      </Text>
                      <Text style={styles.scheduleType}>ধরন: {s.type}</Text>
                    </View>
                    <Switch
                      value={s.isActive}
                      onValueChange={() =>
                        sendWsCommand('TOGGLE_SCHEDULE', { id: s._id, isActive: !s.isActive })
                      }
                    />
                  </View>
                ))
              )}
            </View>

            {/* Run Logs */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>রিসেন্ট মোটর রান লগ</Text>
              {motorLogs.length === 0 ? (
                <Text style={styles.emptyNotice}>কোনো লগ পাওয়া যায়নি।</Text>
              ) : (
                motorLogs.map((log, idx) => (
                  <View key={log._id || idx} style={styles.logItem}>
                    <View style={styles.logLeft}>
                      <Text style={styles.logDate}>{log.bdDate || 'Date: N/A'}</Text>
                      <Text style={styles.logTime}>শুরু: {log.bdTime || 'N/A'}</Text>
                    </View>
                    <View style={styles.logRight}>
                      <Text style={styles.logDuration}>{log.duration || 'Running'}</Text>
                    </View>
                  </View>
                ))
              )}
            </View>
          </View>
        )}

        {/* ----------------- TAB 4: SETTINGS ----------------- */}
        {activeTab === 'settings' && (
          <View>
            {/* Password Change Option */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>সিকিউরিটি ও পাসওয়ার্ড</Text>
              <Text style={styles.sectionDesc}>
                সার্ভারের file.db-তে সংরক্ষিত পাসওয়ার্ড পরিবর্তন করুন
              </Text>
              <TouchableOpacity
                style={styles.changePasswordBtn}
                onPress={() => setChangePwdVisible(true)}
              >
                <Text style={styles.changePasswordBtnText}>🔑 পাসওয়ার্ড পরিবর্তন করুন</Text>
              </TouchableOpacity>
            </View>

            {/* Server Info Card */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>সার্ভার ও সিস্টেম তথ্য</Text>
              <View style={styles.infoRow}>
                <Text style={styles.infoKey}>HTTP Server:</Text>
                <Text style={styles.infoVal}>{serverUrl}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoKey}>WebSocket:</Text>
                <Text style={styles.infoVal}>{wsUrl}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoKey}>ESP32 Device IP:</Text>
                <Text style={styles.infoVal}>{localIP}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoKey}>Firmware Version:</Text>
                <Text style={styles.infoVal}>v{firmwareVersion}</Text>
              </View>
            </View>

            {/* Logout Card */}
            <TouchableOpacity style={styles.bigLogoutBtn} onPress={handleLogout}>
              <Text style={styles.bigLogoutBtnText}>🚪 লগআউট (Logout)</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Bottom Navigation Tab Bar */}
      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={[styles.navTab, activeTab === 'control' && styles.navTabActive]}
          onPress={() => setActiveTab('control')}
        >
          <Text style={styles.navIcon}>⚡</Text>
          <Text style={[styles.navLabel, activeTab === 'control' && styles.navLabelActive]}>
            কন্ট্রোল
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.navTab, activeTab === 'gsm' && styles.navTabActive]}
          onPress={() => setActiveTab('gsm')}
        >
          <Text style={styles.navIcon}>📶</Text>
          <Text style={[styles.navLabel, activeTab === 'gsm' && styles.navLabelActive]}>
            সিম / USSD
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.navTab, activeTab === 'logs' && styles.navTabActive]}
          onPress={() => setActiveTab('logs')}
        >
          <Text style={styles.navIcon}>📋</Text>
          <Text style={[styles.navLabel, activeTab === 'logs' && styles.navLabelActive]}>
            শিডিউল
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.navTab, activeTab === 'settings' && styles.navTabActive]}
          onPress={() => setActiveTab('settings')}
        >
          <Text style={styles.navIcon}>⚙️</Text>
          <Text style={[styles.navLabel, activeTab === 'settings' && styles.navLabelActive]}>
            সেটিংস
          </Text>
        </TouchableOpacity>
      </View>

      {/* ----------------- ACTION CONFIRMATION MODAL ----------------- */}
      <Modal
        visible={confirmModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.confirmModalBox}>
            <Text style={styles.confirmModalTitle}>{pendingAction?.title}</Text>
            <Text style={styles.confirmModalMessage}>{pendingAction?.message}</Text>
            <View style={styles.confirmModalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setConfirmModalVisible(false)}
              >
                <Text style={styles.cancelBtnText}>বাতিল</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.confirmBtn}
                onPress={executePendingAction}
              >
                <Text style={styles.confirmBtnText}>হ্যাঁ, পাঠান</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ----------------- CHANGE PASSWORD MODAL ----------------- */}
      <Modal
        visible={changePwdVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setChangePwdVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.pwdModalBox}>
            <Text style={styles.pwdModalTitle}>পাসওয়ার্ড পরিবর্তন করুন</Text>
            <Text style={styles.pwdModalDesc}>সার্ভারের file.db-তে নতুন পাসওয়ার্ড সংরক্ষিত হবে</Text>

            <TextInput
              style={styles.pwdInput}
              placeholder="বর্তমান পাসওয়ার্ড..."
              placeholderTextColor="#94a3b8"
              secureTextEntry
              value={oldPassword}
              onChangeText={setOldPassword}
            />
            <TextInput
              style={styles.pwdInput}
              placeholder="নতুন পাসওয়ার্ড..."
              placeholderTextColor="#94a3b8"
              secureTextEntry
              value={newPassword}
              onChangeText={setNewPassword}
            />
            <TextInput
              style={styles.pwdInput}
              placeholder="নতুন পাসওয়ার্ড নিশ্চিত করুন..."
              placeholderTextColor="#94a3b8"
              secureTextEntry
              value={confirmPassword}
              onChangeText={setConfirmPassword}
            />

            <View style={styles.pwdModalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setChangePwdVisible(false)}
                disabled={changePwdLoading}
              >
                <Text style={styles.cancelBtnText}>বাতিল</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.confirmBtn}
                onPress={handleChangePassword}
                disabled={changePwdLoading}
              >
                {changePwdLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.confirmBtnText}>সেভ করুন</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ==========================================
// STYLES
// ==========================================
const styles = StyleSheet.create({
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f172a',
  },
  loadingText: {
    color: '#94a3b8',
    marginTop: 12,
    fontSize: 16,
    fontWeight: '600',
  },

  // Login Styles
  loginContainer: {
    flex: 1,
    backgroundColor: '#f1f5f9',
  },
  loginScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  loginHeader: {
    alignItems: 'center',
    marginBottom: 24,
  },
  loginIconBadge: {
    width: 72,
    height: 72,
    borderRadius: 24,
    backgroundColor: '#e0f2fe',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  loginIconText: {
    fontSize: 36,
  },
  loginTitle: {
    fontSize: 28,
    fontWeight: '900',
    color: '#0f172a',
  },
  loginSubtitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0284c7',
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  loginInstruction: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 8,
    textAlign: 'center',
  },
  loginCard: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 8,
  },
  passwordInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 12,
  },
  passwordInput: {
    flex: 1,
    height: 48,
    fontSize: 16,
    color: '#0f172a',
  },
  eyeBtn: {
    padding: 8,
  },
  eyeBtnText: {
    fontSize: 18,
  },
  errorBox: {
    backgroundColor: '#fee2e2',
    borderRadius: 8,
    padding: 10,
    marginTop: 12,
  },
  errorText: {
    color: '#dc2626',
    fontSize: 13,
    fontWeight: '600',
  },
  loginBtn: {
    backgroundColor: '#0284c7',
    height: 50,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 18,
    shadowColor: '#0284c7',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  loginBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  defaultPwdNote: {
    marginTop: 16,
    alignItems: 'center',
  },
  defaultPwdText: {
    fontSize: 12,
    color: '#94a3b8',
    fontWeight: '500',
  },
  serverConfigToggle: {
    marginTop: 20,
    alignItems: 'center',
  },
  serverConfigToggleText: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '600',
  },
  serverConfigBox: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  serverConfigLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 6,
  },
  serverConfigInput: {
    height: 40,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
  },
  saveServerBtn: {
    backgroundColor: '#334155',
    borderRadius: 8,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 10,
  },
  saveServerBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },

  // Main Dashboard Styles
  mainContainer: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  appBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  appBarTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#ffffff',
  },
  appBarSubtitle: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '500',
    marginTop: 2,
  },
  appBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    gap: 6,
  },
  badgeSuccess: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
  },
  badgeError: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#f8fafc',
  },
  logoutBtn: {
    padding: 6,
  },
  logoutBtnText: {
    fontSize: 18,
  },
  contentScroll: {
    flex: 1,
  },
  contentPadding: {
    padding: 16,
    paddingBottom: 32,
  },

  // Motor Status Card
  motorCard: {
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  motorCardRunning: {
    backgroundColor: '#15803d',
  },
  motorCardStopped: {
    backgroundColor: '#dc2626',
  },
  motorCardLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.8)',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  motorCardStatus: {
    fontSize: 32,
    fontWeight: '900',
    color: '#ffffff',
    marginVertical: 12,
    textAlign: 'center',
  },
  motorMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  motorMetaText: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '600',
  },
  motorMetaDivider: {
    color: 'rgba(255,255,255,0.6)',
  },
  lastActionBox: {
    marginTop: 16,
    backgroundColor: 'rgba(0,0,0,0.2)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
  },
  lastActionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#f8fafc',
  },
  lastActionText: {
    fontSize: 11,
    color: '#f8fafc',
    flexShrink: 1,
  },

  // Action Buttons
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  actionButton: {
    flex: 1,
    height: 70,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  btnStart: {
    backgroundColor: '#16a34a',
  },
  btnStop: {
    backgroundColor: '#dc2626',
  },
  actionButtonIcon: {
    fontSize: 20,
    marginBottom: 2,
  },
  actionButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
  },
  resetButton: {
    backgroundColor: '#334155',
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  resetButtonText: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.5,
  },

  // Section Cards
  sectionCard: {
    backgroundColor: '#1e293b',
    borderRadius: 18,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 6,
  },
  sectionDesc: {
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 14,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  switchTextCol: {
    flex: 1,
    paddingRight: 12,
  },
  switchLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#f8fafc',
  },
  switchDescription: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  emptyNotice: {
    color: '#64748b',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 12,
  },

  // GSM Phone List Styles
  addSmallBtn: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  addSmallBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  addPhoneBox: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  phoneInput: {
    flex: 1,
    height: 42,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 12,
    color: '#ffffff',
    fontSize: 14,
  },
  confirmAddBtn: {
    backgroundColor: '#10b981',
    paddingHorizontal: 16,
    borderRadius: 8,
    justifyContent: 'center',
  },
  confirmAddBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  phoneItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  phoneItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  phoneBadge: {
    backgroundColor: '#334155',
    color: '#94a3b8',
    width: 22,
    height: 22,
    borderRadius: 11,
    textAlign: 'center',
    lineHeight: 22,
    fontSize: 11,
    fontWeight: '700',
  },
  phoneNumberText: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  phoneDelBtn: {
    padding: 6,
  },
  phoneDelText: {
    fontSize: 16,
  },

  // USSD Styles
  quickUssdRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  quickUssdBtn: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  quickUssdBtnLabel: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '800',
  },
  quickUssdBtnCode: {
    color: '#94a3b8',
    fontSize: 10,
    marginTop: 2,
  },
  ussdInputRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  ussdTextInput: {
    flex: 1,
    height: 44,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 12,
    color: '#ffffff',
    fontSize: 15,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  ussdDialBtn: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 18,
    borderRadius: 10,
    justifyContent: 'center',
  },
  ussdDialBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  ussdResponseCard: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  ussdResponseHeader: {
    fontSize: 12,
    fontWeight: '800',
    color: '#38bdf8',
    marginBottom: 6,
  },
  ussdResponseContent: {
    fontSize: 13,
    color: '#f8fafc',
    lineHeight: 20,
  },

  // Schedules & Logs Styles
  scheduleItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    padding: 12,
    borderRadius: 10,
    marginBottom: 8,
  },
  scheduleLeft: {
    flex: 1,
  },
  scheduleTime: {
    fontSize: 14,
    fontWeight: '800',
    color: '#f8fafc',
  },
  scheduleType: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  logItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    padding: 12,
    borderRadius: 10,
    marginBottom: 8,
  },
  logLeft: {
    flex: 1,
  },
  logDate: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f8fafc',
  },
  logTime: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  logRight: {
    backgroundColor: '#334155',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  logDuration: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },

  // Settings Styles
  changePasswordBtn: {
    backgroundColor: '#334155',
    height: 44,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  changePasswordBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  infoKey: {
    fontSize: 12,
    color: '#94a3b8',
    fontWeight: '600',
  },
  infoVal: {
    fontSize: 12,
    color: '#f8fafc',
    fontWeight: '700',
  },
  bigLogoutBtn: {
    backgroundColor: '#dc2626',
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  bigLogoutBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
  },

  // Bottom Navigation Bar
  bottomNav: {
    flexDirection: 'row',
    height: 64,
    backgroundColor: '#1e293b',
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  navTab: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  navTabActive: {
    borderTopWidth: 2,
    borderTopColor: '#38bdf8',
  },
  navIcon: {
    fontSize: 18,
  },
  navLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#94a3b8',
    marginTop: 2,
  },
  navLabelActive: {
    color: '#38bdf8',
    fontWeight: '800',
  },

  // Modals
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  confirmModalBox: {
    backgroundColor: '#1e293b',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderColor: '#475569',
  },
  confirmModalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 8,
  },
  confirmModalMessage: {
    fontSize: 14,
    color: '#cbd5e1',
    lineHeight: 20,
    marginBottom: 20,
  },
  confirmModalActions: {
    flexDirection: 'row',
    gap: 12,
  },
  cancelBtn: {
    flex: 1,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#334155',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelBtnText: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '700',
  },
  confirmBtn: {
    flex: 1,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#0284c7',
    justifyContent: 'center',
    alignItems: 'center',
  },
  confirmBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  pwdModalBox: {
    backgroundColor: '#1e293b',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderColor: '#475569',
  },
  pwdModalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ffffff',
  },
  pwdModalDesc: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 4,
    marginBottom: 16,
  },
  pwdInput: {
    height: 42,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 12,
    color: '#ffffff',
    fontSize: 14,
    marginBottom: 10,
  },
  pwdModalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 10,
  },
});
