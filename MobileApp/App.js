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
  Animated,
  Easing,
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
  const [logCurrentPage, setLogCurrentPage] = useState(0);
  const [logTotalPages, setLogTotalPages] = useState(1);
  const [logLoading, setLogLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Change Password Modal
  const [changePwdVisible, setChangePwdVisible] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changePwdLoading, setChangePwdLoading] = useState(false);

  // Reset Password via Registered Phone
  const [resetModalVisible, setResetModalVisible] = useState(false);
  const [resetPhone, setResetPhone] = useState('');
  const [resetNewPwd, setResetNewPwd] = useState('');
  const [resetConfirmPwd, setResetConfirmPwd] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState('');

  // Action Confirmation Modal
  const [confirmModalVisible, setConfirmModalVisible] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  // Motor Animation Values (Gear Spin & Glow Pulse like Web Dashboard)
  const spinValue = useRef(new Animated.Value(0)).current;
  const pulseValue = useRef(new Animated.Value(1)).current;
  const glowOpacity = useRef(new Animated.Value(0.3)).current;
  const [motorRunSeconds, setMotorRunSeconds] = useState(0);

  useEffect(() => {
    let spinAnim = null;
    let pulseAnim = null;
    let glowAnim = null;
    let timer = null;

    if (motorStatus === 'ON') {
      spinValue.setValue(0);
      spinAnim = Animated.loop(
        Animated.timing(spinValue, {
          toValue: 1,
          duration: 1200,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );
      spinAnim.start();

      pulseValue.setValue(1);
      pulseAnim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseValue, {
            toValue: 1.15,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseValue, {
            toValue: 1.0,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      pulseAnim.start();

      glowAnim = Animated.loop(
        Animated.sequence([
          Animated.timing(glowOpacity, {
            toValue: 0.8,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(glowOpacity, {
            toValue: 0.25,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      );
      glowAnim.start();

      timer = setInterval(() => {
        setMotorRunSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      spinValue.stopAnimation();
      spinValue.setValue(0);
      pulseValue.stopAnimation();
      pulseValue.setValue(1);
      glowOpacity.stopAnimation();
      glowOpacity.setValue(0);
      setMotorRunSeconds(0);
    }

    return () => {
      if (spinAnim) spinAnim.stop();
      if (pulseAnim) pulseAnim.stop();
      if (glowAnim) glowAnim.stop();
      if (timer) clearInterval(timer);
    };
  }, [motorStatus]);

  const spinInterpolation = spinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const formatElapsedTime = (totalSecs) => {
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hrs > 0) {
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

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
          if (data.payload.lastAction !== undefined) {
            setLastAction(data.payload.lastAction);
            if (data.payload.lastAction.includes('Logs Cleared')) {
              setMotorLogs([]);
            }
          }
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
        setLogLoading(false);
        if (data.payload) {
          const rawLogs = data.payload.motorLogs || data.payload.logs || [];
          const parsedList = [];
          if (Array.isArray(rawLogs)) {
            rawLogs.forEach((item) => {
              try {
                const parsed = typeof item === 'string' ? JSON.parse(item) : item;
                if (parsed && (parsed.onTime || parsed.offTime || parsed.duration)) {
                  parsedList.push(parsed);
                }
              } catch (e) {
                console.warn('Could not parse log item:', item);
              }
            });
          }
          setMotorLogs(parsedList);
          if (data.payload.currentPage !== undefined) setLogCurrentPage(data.payload.currentPage);
          if (data.payload.totalPages !== undefined) setLogTotalPages(data.payload.totalPages || 1);
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
      Alert.alert('Offline', 'No connection to server. Please wait.');
    }
  };

  // 3. Auth Actions
  const handleLogin = async () => {
    if (!loginPassword.trim()) {
      setLoginError('Please enter password');
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
        setLoginError(data.message || 'Incorrect password! Please try again.');
      }
    } catch (err) {
      setLoginError('Cannot connect to server. Please check URL.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    Alert.alert('Logout', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log Out',
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
    Alert.alert('Success', `Server URL updated:\n${clean}`);
  };

  const handleChangePassword = async () => {
    if (!oldPassword || !newPassword || !confirmPassword) {
      Alert.alert('Error', 'Please fill in all fields');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Error', 'New passwords do not match!');
      return;
    }
    if (newPassword.length < 3) {
      Alert.alert('Error', 'New password must be at least 3 characters');
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
        Alert.alert('Success', data.message || 'Password changed successfully!');
        setChangePwdVisible(false);
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        Alert.alert('Failed', data.message || 'Failed to change password!');
      }
    } catch (e) {
      Alert.alert('Error', 'Server communication error.');
    } finally {
      setChangePwdLoading(false);
    }
  };

  const handleResetPasswordByPhone = async () => {
    if (!resetPhone.trim() || !resetNewPwd.trim() || !resetConfirmPwd.trim()) {
      Alert.alert('Error', 'Please fill in all fields');
      return;
    }
    if (resetNewPwd !== resetConfirmPwd) {
      Alert.alert('Error', 'New passwords do not match!');
      return;
    }
    if (resetNewPwd.length < 3) {
      Alert.alert('Error', 'New password must be at least 3 characters');
      return;
    }

    setResetLoading(true);
    setResetError('');
    try {
      const res = await fetch(`${serverUrl}/api/reset-password-by-phone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: resetPhone.trim(),
          newPassword: resetNewPwd.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        Alert.alert('Success', data.message || 'Password changed successfully!');
        setResetModalVisible(false);
        setLoginPassword(resetNewPwd.trim());
        setResetPhone('');
        setResetNewPwd('');
        setResetConfirmPwd('');
      } else {
        setResetError(data.message || 'Failed to reset password!');
        Alert.alert('Failed', data.message || 'Failed to change password!');
      }
    } catch (e) {
      setResetError('Cannot connect to server.');
      Alert.alert('Error', 'Cannot connect to server.');
    } finally {
      setResetLoading(false);
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
      Alert.alert('Error', 'Enter a valid mobile number (e.g. 01712345678)');
      return;
    }
    if (adminPhones.length >= 5) {
      Alert.alert('Limit Reached', 'Maximum 5 numbers allowed.');
      return;
    }
    sendWsCommand('ADD_PHONE', clean);
    setNewPhoneInput('');
    setIsAddingPhone(false);
  };

  const handleRemovePhone = (phone) => {
    Alert.alert('Delete Number', `Are you sure you want to delete ${phone}?`, [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes, Delete',
        style: 'destructive',
        onPress: () => sendWsCommand('REMOVE_PHONE', phone),
      },
    ]);
  };

  // 6. USSD Actions
  const handleDialUssd = (codeToDial) => {
    const code = (codeToDial || ussdInput).trim();
    if (!code) {
      Alert.alert('Error', 'Enter a USSD code (e.g. *566#)');
      return;
    }
    setIsDialingUssd(true);
    setUssdResponse('');
    setUssdResponseCode(code);
    sendWsCommand('DIAL_USSD', code);
  };

  // 7. Motor Activity Log Actions
  const handleLoadLogs = (page = 0) => {
    setLogLoading(true);
    sendWsCommand('GET_LOG_PAGE', page);
  };

  const handleClearAllLogs = () => {
    Alert.alert(
      'Clear All Logs?',
      'Are you sure you want to delete all motor activity logs from server?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Yes, Delete',
          style: 'destructive',
          onPress: () => {
            sendWsCommand('CLEAR_LOGS');
            setMotorLogs([]);
          },
        },
      ]
    );
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
        <Text style={styles.loadingText}>Loading Mutho-Sech...</Text>
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
            <Text style={styles.loginTitle}>Mutho-Sech Controller</Text>
            <Text style={styles.loginSubtitle}>Smart Pump & Motor Controller</Text>
            <Text style={styles.loginInstruction}>
              Enter system password to access control panel
            </Text>
          </View>

          {/* Login Card */}
          <View style={styles.loginCard}>
            <Text style={styles.inputLabel}>System Password</Text>
            <View style={styles.passwordInputWrapper}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Enter password..."
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
                <Text style={styles.loginBtnText}>Log In to Panel</Text>
              )}
            </TouchableOpacity>

            {/* Forgot Password via Registered Phone */}
            <TouchableOpacity
              style={styles.forgotPwdBtn}
              onPress={() => {
                setResetError('');
                setResetModalVisible(true);
              }}
            >
              <Text style={styles.forgotPwdBtnText}>
                🔑 Forgot Password? Reset with registered number
              </Text>
            </TouchableOpacity>

            <View style={styles.defaultPwdNote}>
              <Text style={styles.defaultPwdText}>Default Password: 1234</Text>
            </View>
          </View>

          {/* Server Config Toggle */}
          <TouchableOpacity
            style={styles.serverConfigToggle}
            onPress={() => setShowServerConfig(!showServerConfig)}
          >
            <Text style={styles.serverConfigToggleText}>
              ⚙️ Server Settings ({serverUrl.replace('https://', '').replace('http://', '')})
            </Text>
          </TouchableOpacity>

          {showServerConfig && (
            <View style={styles.serverConfigBox}>
              <Text style={styles.serverConfigLabel}>Server URL (HTTP/HTTPS):</Text>
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
                <Text style={styles.saveServerBtnText}>Save URL</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>

        {/* Reset Password Modal */}
        <Modal
          visible={resetModalVisible}
          transparent={true}
          animationType="slide"
          onRequestClose={() => setResetModalVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.confirmModalBox}>
              <Text style={styles.confirmModalTitle}>📱 Reset Password</Text>
              <Text style={styles.confirmModalMessage}>
                Enter registered mobile number. Verified number allows setting a new password.
              </Text>

              <TextInput
                style={styles.modalInput}
                placeholder="Registered number (e.g. 017xxxxxxxx)"
                placeholderTextColor="#64748b"
                value={resetPhone}
                onChangeText={setResetPhone}
                keyboardType="phone-pad"
              />

              <TextInput
                style={styles.modalInput}
                placeholder="New password (min 3 chars)"
                placeholderTextColor="#64748b"
                value={resetNewPwd}
                onChangeText={setResetNewPwd}
                secureTextEntry
              />

              <TextInput
                style={styles.modalInput}
                placeholder="Confirm new password"
                placeholderTextColor="#64748b"
                value={resetConfirmPwd}
                onChangeText={setResetConfirmPwd}
                secureTextEntry
              />

              {resetError ? (
                <Text style={[styles.errorText, { marginBottom: 12 }]}>
                  ⚠️ {resetError}
                </Text>
              ) : null}

              <View style={styles.confirmModalBtnRow}>
                <TouchableOpacity
                  style={[styles.confirmBtn, styles.btnCancel]}
                  onPress={() => setResetModalVisible(false)}
                  disabled={resetLoading}
                >
                  <Text style={styles.confirmBtnText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.confirmBtn, styles.btnConfirm]}
                  onPress={handleResetPasswordByPhone}
                  disabled={resetLoading}
                >
                  {resetLoading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.confirmBtnText}>Reset Password</Text>
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
  // RENDER: MAIN DASHBOARD (AUTHENTICATED)
  // ==========================================
  return (
    <SafeAreaView style={styles.mainContainer}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />

      {/* Top App Bar */}
      <View style={styles.appBar}>
        <View>
          <Text style={styles.appBarTitle}>Mutho-Sech</Text>
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
            {/* Animated Motor Status Hero Card (Styled & Animated like Web Dashboard) */}
            <View
              style={[
                styles.motorCard,
                motorStatus === 'ON' ? styles.motorCardRunning : styles.motorCardStopped,
              ]}
            >
              {/* Card Header Bar */}
              <View style={styles.motorCardHeader}>
                <Text style={styles.motorCardLabel}>MOTOR CONTROL CENTER</Text>
                <View
                  style={[
                    styles.modePillBadge,
                    systemMode === 'Normal' ? styles.modeNormal : styles.modeEmergency,
                  ]}
                >
                  <Text style={styles.modePillText}>{systemMode} Mode</Text>
                </View>
              </View>

              {/* Central Animated Spinning Gear & Pulsing Aura */}
              <View style={styles.animCenterContainer}>
                {/* Glowing Aura Ring when Running */}
                {motorStatus === 'ON' && (
                  <Animated.View
                    style={[
                      styles.glowAura,
                      {
                        transform: [{ scale: pulseValue }],
                        opacity: glowOpacity,
                      },
                    ]}
                  />
                )}

                {/* Rotating Gear Motor Icon (like web dashboard's 1s linear spin) */}
                <Animated.View
                  style={[
                    styles.gearContainer,
                    motorStatus === 'ON' ? styles.gearRunning : styles.gearStopped,
                    { transform: [{ rotate: spinInterpolation }] },
                  ]}
                >
                  {/* 8 Cog Teeth around the circumference */}
                  <View style={[styles.cogTooth, { transform: [{ rotate: '0deg' }] }]} />
                  <View style={[styles.cogTooth, { transform: [{ rotate: '45deg' }] }]} />
                  <View style={[styles.cogTooth, { transform: [{ rotate: '90deg' }] }]} />
                  <View style={[styles.cogTooth, { transform: [{ rotate: '135deg' }] }]} />

                  {/* Inner Ring */}
                  <View style={styles.gearInnerRing}>
                    {/* Center Core Hub */}
                    <View
                      style={[
                        styles.gearCenterHub,
                        motorStatus === 'ON' ? styles.hubRunning : styles.hubStopped,
                      ]}
                    >
                      <Text style={styles.hubIconText}>
                        {motorStatus === 'ON' ? '⚡' : '⚙️'}
                      </Text>
                    </View>
                  </View>
                </Animated.View>

                {/* Status Typography */}
                <View style={styles.animStatusTextCol}>
                  <View style={styles.statusPillRow}>
                    <View
                      style={[
                        styles.statusDotLg,
                        { backgroundColor: motorStatus === 'ON' ? '#4ade80' : '#f87171' },
                      ]}
                    />
                    <Text style={styles.motorCardStatus}>
                      {motorStatus === 'ON' ? 'MOTOR RUNNING (ON)' : 'MOTOR STOPPED (OFF)'}
                    </Text>
                  </View>

                  {motorStatus === 'ON' ? (
                    <View style={styles.runningTimerBadge}>
                      <Text style={styles.timerIcon}>⏱️</Text>
                      <Text style={styles.timerText}>Running: {formatElapsedTime(motorRunSeconds)}</Text>
                    </View>
                  ) : (
                    <Text style={styles.motorSubtitleText}>System Standby / Ready</Text>
                  )}
                </View>
              </View>

              {/* Meta details bar */}
              <View style={styles.motorMetaRow}>
                <View style={styles.metaCol}>
                  <Text style={styles.metaKey}>WiFi Signal</Text>
                  <Text style={styles.metaVal}>📶 {wifiSignal}%</Text>
                </View>
                <View style={styles.metaDivider} />
                <View style={styles.metaCol}>
                  <Text style={styles.metaKey}>Device IP</Text>
                  <Text style={styles.metaVal}>{localIP}</Text>
                </View>
                <View style={styles.metaDivider} />
                <View style={styles.metaCol}>
                  <Text style={styles.metaKey}>Server Status</Text>
                  <Text style={[styles.metaVal, { color: wsConnected ? '#4ade80' : '#f87171' }]}>
                    {wsConnected ? 'Connected' : 'Disconnected'}
                  </Text>
                </View>
              </View>

              {/* Last Action Bar */}
              <View style={styles.lastActionBox}>
                <Text style={styles.lastActionLabel}>Last Action:</Text>
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
                    'Confirm Motor Start',
                    'Do you want to send START pulse to turn ON motor?'
                  )
                }
                disabled={!espOnline}
              >
                <Text style={styles.actionButtonIcon}>▶️</Text>
                <Text style={styles.actionButtonText}>Start Motor (START)</Text>
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
                    'Confirm Motor Stop',
                    'Do you want to send STOP pulse to turn OFF motor?'
                  )
                }
                disabled={!espOnline}
              >
                <Text style={styles.actionButtonIcon}>⏹️</Text>
                <Text style={styles.actionButtonText}>Stop Motor (STOP)</Text>
              </TouchableOpacity>
            </View>

            {/* Reset Button */}
            <TouchableOpacity
              style={[styles.resetButton, !espOnline && styles.btnDisabled]}
              onPress={() =>
                confirmAction(
                  'RESET',
                  'Confirm System Reset',
                  'Do you want to send system RESET pulse?'
                )
              }
              disabled={!espOnline}
            >
              <Text style={styles.resetButtonText}>🔄 System Reset (RESET)</Text>
            </TouchableOpacity>

            {/* Mode & Automation Settings */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>⚡ Automatic Power Control</Text>
              <View style={styles.switchRow}>
                <View style={styles.switchTextCol}>
                  <Text style={styles.switchLabel}>Always ON (Keep Running)</Text>
                  <Text style={styles.switchDescription}>
                    Automatically restarts motor when electricity recovers after outage
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

            {/* Voice Audio Test Section (DFPlayer Mini) */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>🔊 Voice & Speaker Test (DFPlayer Mini)</Text>
              <Text style={styles.sectionDesc}>Test voice announcements on control box speaker</Text>
              <View style={styles.audioBtnRow}>
                <TouchableOpacity
                  style={[styles.audioTestBtn, !espOnline && styles.btnDisabled]}
                  onPress={() => {
                    sendWsCommand('PLAY_AUDIO', { track: 7 });
                    Alert.alert('Audio Test', 'Playing Motor ON voice track (006)');
                  }}
                  disabled={!espOnline}
                >
                  <Text style={styles.audioTestIcon}>📢</Text>
                  <Text style={styles.audioTestText}>Motor ON (006)</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.audioTestBtn, !espOnline && styles.btnDisabled]}
                  onPress={() => {
                    sendWsCommand('PLAY_AUDIO', { track: 10 });
                    Alert.alert('Audio Test', 'Playing Motor OFF voice track (009)');
                  }}
                  disabled={!espOnline}
                >
                  <Text style={styles.audioTestIcon}>🔈</Text>
                  <Text style={styles.audioTestText}>Motor OFF (009)</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.audioTestBtn, !espOnline && styles.btnDisabled]}
                  onPress={() => {
                    sendWsCommand('PLAY_AUDIO', { track: 1 });
                    Alert.alert('Audio Test', 'Playing Welcome voice track (001)');
                  }}
                  disabled={!espOnline}
                >
                  <Text style={styles.audioTestIcon}>👋</Text>
                  <Text style={styles.audioTestText}>Welcome (001)</Text>
                </TouchableOpacity>
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
                  Authorized Admin Numbers ({adminPhones.length}/5)
                </Text>
                {adminPhones.length < 5 && (
                  <TouchableOpacity
                    style={styles.addSmallBtn}
                    onPress={() => setIsAddingPhone(!isAddingPhone)}
                  >
                    <Text style={styles.addSmallBtnText}>
                      {isAddingPhone ? 'Cancel' : '+ Add Number'}
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
                    <Text style={styles.confirmAddBtnText}>Add</Text>
                  </TouchableOpacity>
                </View>
              )}

              {adminPhones.length === 0 ? (
                <Text style={styles.emptyNotice}>No admin numbers added yet.</Text>
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
              <Text style={styles.sectionTitle}>USSD Dial & Balance Check</Text>
              <Text style={styles.sectionDesc}>
                Dial USSD code to check SIM balance and telecom offers
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
                    <Text style={styles.ussdDialBtnText}>Dial</Text>
                  )}
                </TouchableOpacity>
              </View>

              {/* USSD Response Box */}
              {ussdResponse ? (
                <View style={styles.ussdResponseCard}>
                  <Text style={styles.ussdResponseHeader}>
                    📩 USSD Response ({ussdResponseCode}):
                  </Text>
                  <Text style={styles.ussdResponseContent}>{ussdResponse}</Text>
                </View>
              ) : null}
            </View>
          </View>
        )}

        {/* ----------------- TAB 2: MOTOR ACTIVITY LOG ----------------- */}
        {activeTab === 'activity' && (
          <View>
            {/* Header with Title & Action Buttons */}
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeaderRow}>
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={styles.sectionTitle}>📊 Motor Activity Log</Text>
                  <Text style={styles.sectionDesc}>Motor start time, stop time, and run duration</Text>
                </View>
                <View style={styles.logHeaderBtns}>
                  <TouchableOpacity
                    style={styles.iconActionBtn}
                    onPress={() => handleLoadLogs(logCurrentPage)}
                    title="Reload"
                  >
                    <Text style={styles.iconActionBtnText}>🔄</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.iconActionBtn, styles.btnDelAction]}
                    onPress={handleClearAllLogs}
                    title="Clear All"
                  >
                    <Text style={styles.iconActionBtnText}>🗑️</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Stats Bar */}
              <View style={styles.logStatsBar}>
                <View style={styles.logStatItem}>
                  <Text style={styles.logStatLabel}>Logs on Page</Text>
                  <Text style={styles.logStatValue}>{motorLogs.length}</Text>
                </View>
                <View style={styles.logStatDivider} />
                <View style={styles.logStatItem}>
                  <Text style={styles.logStatLabel}>Total Pages</Text>
                  <Text style={styles.logStatValue}>{logTotalPages}</Text>
                </View>
                <View style={styles.logStatDivider} />
                <View style={styles.logStatItem}>
                  <Text style={styles.logStatLabel}>Current Page</Text>
                  <Text style={styles.logStatValue}>#{logCurrentPage + 1}</Text>
                </View>
              </View>
            </View>

            {/* Logs List */}
            {logLoading ? (
              <View style={styles.logLoadingBox}>
                <ActivityIndicator size="small" color="#38bdf8" />
                <Text style={styles.logLoadingText}>Loading log data...</Text>
              </View>
            ) : motorLogs.length === 0 ? (
              <View style={styles.emptyLogCard}>
                <Text style={styles.emptyLogIcon}>📋</Text>
                <Text style={styles.emptyLogTitle}>No motor activity logs found</Text>
                <Text style={styles.emptyLogDesc}>When motor starts and stops, history will be automatically recorded here.</Text>
                <TouchableOpacity
                  style={styles.loadLogsBtn}
                  onPress={() => handleLoadLogs(0)}
                >
                  <Text style={styles.loadLogsBtnText}>🔄 Reload Logs</Text>
                </TouchableOpacity>
              </View>
            ) : (
              motorLogs.map((log, idx) => (
                <View key={idx} style={styles.activityLogCard}>
                  <View style={styles.activityLogHeader}>
                    <View style={styles.activityLogBadgeRow}>
                      <Text style={styles.logNumberBadge}>#{logCurrentPage * 10 + idx + 1}</Text>
                      <View style={styles.durationPill}>
                        <Text style={styles.durationPillIcon}>⏱️</Text>
                        <Text style={styles.durationPillText}>Duration: {log.duration || 'Running'}</Text>
                      </View>
                    </View>
                  </View>

                  <View style={styles.activityTimeRow}>
                    <View style={styles.timeBlock}>
                      <Text style={styles.timeLabelGreen}>🟢 Started (ON):</Text>
                      <Text style={styles.timeValue}>{log.onTime || 'N/A'}</Text>
                    </View>
                    <View style={styles.timeBlock}>
                      <Text style={styles.timeLabelRed}>🔴 Stopped (OFF):</Text>
                      <Text style={styles.timeValue}>{log.offTime || 'N/A'}</Text>
                    </View>
                  </View>
                </View>
              ))
            )}

            {/* Pagination Controls */}
            {motorLogs.length > 0 && (
              <View style={styles.paginationRow}>
                <TouchableOpacity
                  style={[styles.pageBtn, logCurrentPage === 0 && styles.btnDisabled]}
                  disabled={logCurrentPage === 0}
                  onPress={() => handleLoadLogs(Math.max(0, logCurrentPage - 1))}
                >
                  <Text style={styles.pageBtnText}>« Previous</Text>
                </TouchableOpacity>

                <View style={styles.pageIndicator}>
                  <Text style={styles.pageIndicatorText}>
                    Page {logCurrentPage + 1} of {logTotalPages}
                  </Text>
                </View>

                <TouchableOpacity
                  style={[styles.pageBtn, logCurrentPage >= logTotalPages - 1 && styles.btnDisabled]}
                  disabled={logCurrentPage >= logTotalPages - 1}
                  onPress={() => handleLoadLogs(logCurrentPage + 1)}
                >
                  <Text style={styles.pageBtnText}>Next »</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* ----------------- TAB 4: SCHEDULES ----------------- */}
        {activeTab === 'schedules' && (
          <View>
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>⏰ Automation Schedules</Text>
                <TouchableOpacity
                  style={styles.addSmallBtn}
                  onPress={() => sendWsCommand('GET_SCHEDULES')}
                >
                  <Text style={styles.addSmallBtnText}>🔄 Reload</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.sectionDesc}>Motor starts and stops automatically at scheduled times</Text>

              {schedules.length === 0 ? (
                <Text style={styles.emptyNotice}>No schedules found.</Text>
              ) : (
                schedules.map((s, idx) => (
                  <View key={s._id || idx} style={styles.scheduleItem}>
                    <View style={styles.scheduleLeft}>
                      <Text style={styles.scheduleTime}>
                        ⏰ {s.startTime} - {s.endTime}
                      </Text>
                      <Text style={styles.scheduleType}>Type: {s.type}</Text>
                    </View>
                    <Switch
                      value={s.isActive}
                      onValueChange={() =>
                        sendWsCommand('TOGGLE_SCHEDULE', { id: s._id, isActive: !s.isActive })
                      }
                      trackColor={{ false: '#cbd5e1', true: '#38bdf8' }}
                      thumbColor={s.isActive ? '#0284c7' : '#f1f5f9'}
                    />
                  </View>
                ))
              )}
            </View>
          </View>
        )}

        {/* ----------------- TAB 5: SETTINGS ----------------- */}
        {activeTab === 'settings' && (
          <View>
            {/* Password Change Option */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>🔒 Security & Password</Text>
              <Text style={styles.sectionDesc}>
                Change system password stored in MongoDB database
              </Text>
              <TouchableOpacity
                style={styles.changePasswordBtn}
                onPress={() => setChangePwdVisible(true)}
              >
                <Text style={styles.changePasswordBtnText}>🔑 Change Password</Text>
              </TouchableOpacity>
            </View>

            {/* Server Info Card */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Server & System Info</Text>
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
              <Text style={styles.bigLogoutBtnText}>🚪 Log Out</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Bottom Navigation Tab Bar (5 Clean Tabs) */}
      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={[styles.navTab, activeTab === 'control' && styles.navTabActive]}
          onPress={() => setActiveTab('control')}
        >
          <Text style={styles.navIcon}>⚡</Text>
          <Text style={[styles.navLabel, activeTab === 'control' && styles.navLabelActive]}>
            Control
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.navTab, activeTab === 'activity' && styles.navTabActive]}
          onPress={() => {
            setActiveTab('activity');
            handleLoadLogs(0);
          }}
        >
          <Text style={styles.navIcon}>📊</Text>
          <Text style={[styles.navLabel, activeTab === 'activity' && styles.navLabelActive]}>
            Activity
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.navTab, activeTab === 'gsm' && styles.navTabActive]}
          onPress={() => setActiveTab('gsm')}
        >
          <Text style={styles.navIcon}>📶</Text>
          <Text style={[styles.navLabel, activeTab === 'gsm' && styles.navLabelActive]}>
            SIM/USSD
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.navTab, activeTab === 'schedules' && styles.navTabActive]}
          onPress={() => setActiveTab('schedules')}
        >
          <Text style={styles.navIcon}>⏰</Text>
          <Text style={[styles.navLabel, activeTab === 'schedules' && styles.navLabelActive]}>
            Schedule
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.navTab, activeTab === 'settings' && styles.navTabActive]}
          onPress={() => setActiveTab('settings')}
        >
          <Text style={styles.navIcon}>⚙️</Text>
          <Text style={[styles.navLabel, activeTab === 'settings' && styles.navLabelActive]}>
            Settings
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
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.confirmBtn}
                onPress={executePendingAction}
              >
                <Text style={styles.confirmBtnText}>Yes, Send</Text>
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
            <Text style={styles.pwdModalTitle}>Change System Password</Text>
            <Text style={styles.pwdModalDesc}>New password will be securely saved in MongoDB</Text>

            <TextInput
              style={styles.pwdInput}
              placeholder="Current password..."
              placeholderTextColor="#94a3b8"
              secureTextEntry
              value={oldPassword}
              onChangeText={setOldPassword}
            />
            <TextInput
              style={styles.pwdInput}
              placeholder="New password..."
              placeholderTextColor="#94a3b8"
              secureTextEntry
              value={newPassword}
              onChangeText={setNewPassword}
            />
            <TextInput
              style={styles.pwdInput}
              placeholder="Confirm new password..."
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
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.confirmBtn}
                onPress={handleChangePassword}
                disabled={changePwdLoading}
              >
                {changePwdLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.confirmBtnText}>Save</Text>
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
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 28) + 16 : 16,
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
  forgotPwdBtn: {
    marginTop: 14,
    alignItems: 'center',
    paddingVertical: 6,
  },
  forgotPwdBtnText: {
    color: '#0284c7',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
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
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 28) + 12 : 12,
  },
  appBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
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

  // Animated Motor Status Hero Card
  motorCard: {
    borderRadius: 24,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  motorCardRunning: {
    backgroundColor: '#15803d',
    borderWidth: 1.5,
    borderColor: '#4ade80',
  },
  motorCardStopped: {
    backgroundColor: '#1e293b',
    borderWidth: 1.5,
    borderColor: '#dc2626',
  },
  motorCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
  },
  motorCardLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.85)',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  modePillBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
  },
  modeNormal: {
    backgroundColor: 'rgba(34, 197, 94, 0.25)',
    borderWidth: 1,
    borderColor: '#4ade80',
  },
  modeEmergency: {
    backgroundColor: 'rgba(239, 68, 68, 0.25)',
    borderWidth: 1,
    borderColor: '#f87171',
  },
  modePillText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800',
  },

  // Central Animation Visual
  animCenterContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    marginVertical: 10,
    width: '100%',
    gap: 16,
    position: 'relative',
  },
  glowAura: {
    position: 'absolute',
    left: -4,
    width: 86,
    height: 86,
    borderRadius: 43,
    backgroundColor: '#4ade80',
    shadowColor: '#4ade80',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 20,
    elevation: 10,
  },
  gearContainer: {
    width: 78,
    height: 78,
    borderRadius: 39,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
  },
  gearRunning: {
    borderColor: '#4ade80',
    backgroundColor: '#064e3b',
  },
  gearStopped: {
    borderColor: '#f87171',
    backgroundColor: '#450a0a',
  },
  cogTooth: {
    position: 'absolute',
    width: 86,
    height: 12,
    backgroundColor: '#4ade80',
    borderRadius: 3,
    opacity: 0.75,
  },
  gearInnerRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  gearCenterHub: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
  },
  hubRunning: {
    backgroundColor: '#10b981',
  },
  hubStopped: {
    backgroundColor: '#dc2626',
  },
  hubIconText: {
    fontSize: 18,
  },

  animStatusTextCol: {
    flex: 1,
    justifyContent: 'center',
  },
  statusPillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDotLg: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  motorCardStatus: {
    fontSize: 20,
    fontWeight: '900',
    color: '#ffffff',
  },
  runningTimerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    marginTop: 6,
    alignSelf: 'flex-start',
    gap: 4,
  },
  timerIcon: {
    fontSize: 12,
  },
  timerText: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  motorSubtitleText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginTop: 4,
    fontWeight: '600',
  },

  // Meta Row & Last Action
  motorMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
    borderRadius: 12,
    paddingVertical: 10,
    marginTop: 10,
  },
  metaCol: {
    alignItems: 'center',
    flex: 1,
  },
  metaKey: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '600',
  },
  metaVal: {
    fontSize: 12,
    color: '#ffffff',
    fontWeight: '800',
    marginTop: 2,
  },
  metaDivider: {
    width: 1,
    height: 24,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  lastActionBox: {
    marginTop: 12,
    backgroundColor: 'rgba(0,0,0,0.3)',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  lastActionLabel: {
    fontSize: 11,
    fontWeight: '800',
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
  audioBtnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  audioTestBtn: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  audioTestIcon: {
    fontSize: 20,
    marginBottom: 4,
  },
  audioTestText: {
    color: '#38bdf8',
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
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
  // Motor Activity Log Styles
  logHeaderBtns: {
    flexDirection: 'row',
    gap: 8,
  },
  iconActionBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  iconActionBtnText: {
    fontSize: 16,
  },
  btnDelAction: {
    borderColor: '#ef4444',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
  },
  logStatsBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 12,
    paddingVertical: 10,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  logStatItem: {
    alignItems: 'center',
    flex: 1,
  },
  logStatLabel: {
    fontSize: 10,
    color: '#94a3b8',
    fontWeight: '600',
  },
  logStatValue: {
    fontSize: 13,
    color: '#38bdf8',
    fontWeight: '800',
    marginTop: 2,
  },
  logStatDivider: {
    width: 1,
    height: 24,
    backgroundColor: '#334155',
  },
  logLoadingBox: {
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  logLoadingText: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '600',
  },
  emptyLogCard: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
    borderStyle: 'dashed',
    marginVertical: 12,
  },
  emptyLogIcon: {
    fontSize: 40,
    marginBottom: 8,
  },
  emptyLogTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#ffffff',
    textAlign: 'center',
  },
  emptyLogDesc: {
    fontSize: 12,
    color: '#94a3b8',
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 18,
  },
  loadLogsBtn: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 14,
  },
  loadLogsBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  activityLogCard: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  activityLogHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(51, 65, 85, 0.6)',
  },
  activityLogBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  logNumberBadge: {
    backgroundColor: '#0f172a',
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '800',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  durationPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    gap: 4,
  },
  durationPillIcon: {
    fontSize: 12,
  },
  durationPillText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },
  activityTimeRow: {
    gap: 6,
  },
  timeBlock: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  timeLabelGreen: {
    fontSize: 12,
    fontWeight: '700',
    color: '#22c55e',
  },
  timeLabelRed: {
    fontSize: 12,
    fontWeight: '700',
    color: '#ef4444',
  },
  timeValue: {
    fontSize: 12,
    fontWeight: '600',
    color: '#f8fafc',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  paginationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 20,
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  pageBtn: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  pageBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
  },
  pageIndicator: {
    paddingHorizontal: 12,
  },
  pageIndicatorText: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '700',
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
