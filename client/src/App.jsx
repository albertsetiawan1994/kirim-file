import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer/simplepeer.min.js';
import { 
  Monitor, Smartphone, FileUp, Download, X, CheckCircle, Loader2, 
  Wifi, Share2, Files, Trash2, FileIcon, History, 
  Info, Globe, Lock, Zap, Clock, AlertTriangle, ChevronRight,
  Menu, Bell, User, Plus, Search, Filter, RefreshCw, Edit2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import toast, { Toaster } from 'react-hot-toast';

import { 
  formatSize, 
  formatSpeed,
  getDeviceInfo, 
  PEER_CONFIG, 
  emitSignal, 
  parseMessage, 
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  BUFFER_THRESHOLD,
  calculateHash,
  isLocalIP,
  detectConnectionType,
  calculateETA,
  compressData,
  decompressData
} from './utils/transferUtils';

const SIGNALING_URL = 'https://kirim-file.onrender.com'; 

function App() {
  // --- States ---
  const [socket, setSocket] = useState(null);
  const [me, setMe] = useState('');
  const [users, setUsers] = useState([]);
  const [targetUser, setTargetUser] = useState(null);
  const [fileList, setFileList] = useState([]);
  const [transferState, setTransferState] = useState('idle'); // idle, connecting, transferring, completed, error
  const [transferType, setTransferType] = useState('sending'); // sending, receiving
  const [progress, setProgress] = useState(0);
  const [transferSpeed, setTransferSpeed] = useState(0);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [receivedFiles, setReceivedFiles] = useState([]);
  const [history, setHistory] = useState(() => JSON.parse(localStorage.getItem('transferHistory') || '[]'));
  const [incomingSignal, setIncomingSignal] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionMode, setConnectionMode] = useState('Detecting...'); // Lokal, Internet (STUN), Internet (TURN)
  const [roomPin, setRoomPin] = useState('');
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('userDisplayName') || '');
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('userDisplayName'));
  const [tempName, setTempName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [eta, setEta] = useState('--:--');
  const [verifyPin, setVerifyPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentFileMetadata, setCurrentFileMetadata] = useState(null);
  const [processedBytes, setProcessedSize] = useState(0);
  const [isDownloadClicked, setIsDownloadClicked] = useState(false);
  const [gatewayIP, setGatewayIP] = useState('');
  const wakeLockRef = useRef(null);
  
  // --- Refs ---
  const peerRef = useRef();
  const fileInputRef = useRef();
  const speedRef = useRef({ bytes: 0, lastTime: Date.now(), window: [], currentSpeed: 0 });
  const encryptionKeyRef = useRef(null);
  const socketRef = useRef(null);
    const isPausedRef = useRef(false);
    const isCancelledRef = useRef(false);
    const lastEtaValueRef = useRef(0); // Store ETA in seconds for comparison
    const transferTypeRef = useRef('sending');
    const transferStateRef = useRef('idle');
    const retryCountRef = useRef(0);
  const MAX_RETRIES = 3;

  // --- Helpers for Data Channel Protocol ---
  const sendPeerJSON = (peer, data) => {
    if (!peer || peer.destroyed) return;
    try {
      const json = JSON.stringify(data);
      const payload = new TextEncoder().encode(json);
      const msg = new Uint8Array(payload.length + 1);
      msg[0] = 0x00; // Header for JSON
      msg.set(payload, 1);
      peer.send(msg);
    } catch (e) {
      // console.error('[Protocol] Failed to send JSON to peer', e);
    }
  };

  const sendPeerBinary = (peer, data) => {
    if (!peer || peer.destroyed) return;
    try {
      const raw = data instanceof Uint8Array ? data : new Uint8Array(data);
      const msg = new Uint8Array(raw.length + 1);
      msg[0] = 0x01; // Header for Binary
      msg.set(raw, 1);
      peer.send(msg);
    } catch (e) {
      // console.error('[Protocol] Failed to send Binary to peer', e);
    }
  };

  // --- Wake Lock & Background Persistence ---
  useEffect(() => {
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
          // console.log('Wake Lock is active');
        }
      } catch (err) {
        // Silent
      }
    };

    // Re-request wake lock when page becomes visible again
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };

    requestWakeLock();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockRef.current) wakeLockRef.current.release();
    };
  }, []);

  // --- Socket Setup ---
  useEffect(() => {
    const fetchGatewayIP = async () => {
      try {
        const services = [
          'https://api.ipify.org?format=json',
          'https://api.seeip.org/jsonip'
        ];
        
        for (const service of services) {
          try {
            const res = await fetch(service);
            const data = await res.json();
            const ip = data.ip || data.ip_addr || data.query;
            if (ip) {
              setGatewayIP(ip);
              return ip;
            }
          } catch (e) { continue; }
        }
      } catch (e) { }
      return null;
    };

    // Initial fetch
    fetchGatewayIP();

    // Re-fetch on network online or visibility change (common when switching apps/networks)
    const handleNetworkActivity = () => {
      // console.log('[Network] Activity detected, refreshing Gateway IP...');
      fetchGatewayIP();
    };
    window.addEventListener('online', handleNetworkActivity);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fetchGatewayIP();
    });

    const { deviceName, osName, isMobile } = getDeviceInfo();
    const finalName = displayName || `${osName} ${deviceName}`;
    
    const newSocket = io(SIGNALING_URL, {
      transports: ['websocket', 'polling'], // Prefer WebSocket
      secure: true,
      withCredentials: true,
      reconnectionAttempts: 20, // Increased for better stability
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 15000,
      forceNew: true,
      autoConnect: true
    });

    socketRef.current = newSocket;

    newSocket.on('connect_error', (err) => {
      console.error('Signaling connection error:', err.message);
      // Jika websocket gagal, socket.io otomatis akan mencoba polling
    });

    newSocket.on('connect', () => {
      setMe(newSocket.id);
      setIsConnected(true);
      // Join room or register with display name if available
      newSocket.emit('join', {
        name: finalName,
        deviceType: getDeviceInfo().isMobile ? 'mobile' : 'desktop',
        browser: getDeviceInfo().browser,
        gatewayIP: gatewayIP
      });
    });

    newSocket.on('users-list', (usersList) => {
      // console.log('Received users list:', usersList);
      
      // Additional client-side deduplication by name (keep latest joinedAt)
      const uniqueUsersMap = new Map();
      usersList.forEach(user => {
        if (user.id === newSocket.id) return; // Skip self
        const existing = uniqueUsersMap.get(user.name);
        if (!existing || user.joinedAt > existing.joinedAt) {
          uniqueUsersMap.set(user.name, user);
        }
      });
      
      setUsers(Array.from(uniqueUsersMap.values()));
    });

    newSocket.on('signal', ({ from, signal, pin }) => {
      // console.log(`[Signal] Received from ${from}, type: ${signal?.type}`);
      
      // Handle Control Signals (Cancel, Error, Direct-IP, etc) via Signaling Fallback
      if (signal && signal.type === 'control') {
        if (signal.action === 'cancel' || signal.action === 'force-refresh' || signal.action === 'decline') {
          const reason = signal.action === 'decline' ? 'Transfer ditolak oleh penerima' : 
                         signal.action === 'force-refresh' ? 'Koneksi lawan bermasalah' : 'Transfer dibatalkan';
          toast.error(`${reason}. Memuat ulang...`);
          setTimeout(() => window.location.reload(), 2000);
        } else if (signal.action === 'direct-ip') {
          // Silent gateway detection
          // console.log(`%c[Direct IP] Penerima berada di Gateway: ${signal.ip}`, 'color: #3b82f6; font-weight: bold');
          // Jika terdeteksi IP berbeda (lintas gateway), langsung siapkan mode Relay untuk percobaan berikutnya
          if (transferStateRef.current === 'connecting') {
             // console.warn('[Direct IP] Lintas gateway terdeteksi, mengoptimalkan jalur relay...');
          }
        }
        return;
      }

      if (signal.type === 'offer') {
        // console.log('[Signal] Processing incoming offer...');
        setIncomingSignal({ from, signal, pin });
      } else if (peerRef.current) {
        // console.log('[Signal] Forwarding signal to peer...');
        peerRef.current.signal(signal);
      }
    });

    newSocket.on('disconnect', () => {
      // console.warn('[Socket] Disconnected from signaling server');
      setIsConnected(false);
    });

    // Handle signaling errors from server
    newSocket.on('signal-error', ({ code }) => {
      // console.error('[Signal Error]', code);
      if (code === 'RECIPIENT_OFFLINE') {
        toast.error('Penerima sedang offline. Mencoba ulang...');
        setTimeout(() => startTransfer(0), 2000);
      }
    });

    setSocket(newSocket);
    return () => newSocket.close();
  }, []);

  // Update Name in Signaling
  useEffect(() => {
    if (isConnected && socket) {
      if (displayName) localStorage.setItem('userDisplayName', displayName);
      
      socket.emit('join', {
        name: displayName || `${getDeviceInfo().osName} ${getDeviceInfo().deviceName}`,
        deviceType: getDeviceInfo().isMobile ? 'mobile' : 'desktop',
        browser: getDeviceInfo().browser,
        gatewayIP: gatewayIP
      });
    }
  }, [displayName, gatewayIP, socket, isConnected]);

  // --- Effects ---
  useEffect(() => {
    localStorage.setItem('transferHistory', JSON.stringify(history.slice(0, 50)));
  }, [history]);

  // Auto-update targetUser if device reconnects with same name
  useEffect(() => {
    if (targetUser) {
      const updatedTarget = users.find(u => u.name === targetUser.name);
      if (updatedTarget && updatedTarget.id !== targetUser.id) {
        setTargetUser(updatedTarget);
      } else if (!updatedTarget && transferState === 'idle') {
        setTargetUser(null);
      }
    }
  }, [users, targetUser, transferState]);

  // --- Handlers ---
  const handleFileSelect = (e) => {
    const selectedFiles = Array.from(e.target.files);
    if (selectedFiles.length > 0) {
      setFileList(prev => [...prev, ...selectedFiles]);
      toast.success(`${selectedFiles.length} file ditambahkan ke antrean`);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setFileList(prev => [...prev, ...files]);
      toast.success(`${files.length} file ditambahkan via drop`);
    }
  };

  const removeFile = (index) => setFileList(prev => prev.filter((_, i) => i !== index));

  const updateSpeed = (bytes) => {
    const now = Date.now();
    speedRef.current.bytes += bytes;
    const timeDiff = (now - speedRef.current.lastTime) / 1000;
    
    // High-frequency sampling (every 50ms) for real-time responsiveness
    if (timeDiff >= 0.05) {
      const bps = speedRef.current.bytes / timeDiff;
      const validBps = isFinite(bps) ? bps : 0;
      
      // Implement sliding window average (last 20 samples = ~1 second at 50ms)
      const window = speedRef.current.window;
      window.push(validBps);
      if (window.length > 20) window.shift();
      
      const averageBps = window.reduce((a, b) => a + b, 0) / window.length;
      const finalSpeed = averageBps < 1 ? 0 : averageBps;
      
      setTransferSpeed(finalSpeed);
      speedRef.current.currentSpeed = finalSpeed;
      
      speedRef.current.bytes = 0;
      speedRef.current.lastTime = now;
      return finalSpeed;
    }
    return speedRef.current.currentSpeed;
  };

  const startTransfer = async (retryAttempt = 0) => {
    if (fileList.length === 0 || !targetUser) return;
    
    const startTime = Date.now();
    setTransferState('connecting');
    transferStateRef.current = 'connecting';
    setTransferType('sending');
    transferTypeRef.current = 'sending';
    isPausedRef.current = false;
    isCancelledRef.current = false;
    setIsPaused(false);
    setProcessedSize(0);

    // Force Relay (TURN) lebih cepat jika lintas jaringan masih gagal
    const currentConfig = { ...PEER_CONFIG };
    if (retryAttempt >= 1) { // Mulai paksa relay pada retry pertama untuk kecepatan
      console.warn('[Handshake] Memaksa mode Relay (TURN) untuk menembus firewall lintas gateway...');
      currentConfig.iceTransportPolicy = 'relay';
    }

    const peer = new Peer({
      initiator: true,
      trickle: true,
      config: currentConfig,
      allowHalfTrickle: true
    });

    peerRef.current = peer;

    peer.on('signal', (signal) => {
      if (signal.candidate) {
        const mode = detectConnectionType(signal.candidate.candidate);
        // console.log(`[ICE Candidate] Found: ${mode}`);
        setConnectionMode(mode);
      }
      emitSignal(socket, targetUser.id, me, signal, { pin: roomPin });
    });

    // Proactive ICE Connection State Monitoring
    let renegotiateTimeout = null;
    if (peer._pc) {
      peer._pc.oniceconnectionstatechange = () => {
        const state = peer._pc.iceConnectionState;
        // console.log(`[ICE State] ${state}`);
        
        if (state === 'failed' || state === 'disconnected') {
          // console.warn('[ICE] Koneksi terhambat, menyiapkan negosiasi ulang...');
          if (renegotiateTimeout) clearTimeout(renegotiateTimeout);
          // Give it a 2s window to recover before forcing renegotiation
          renegotiateTimeout = setTimeout(() => {
            if (peer._pc && (peer._pc.iceConnectionState === 'failed' || peer._pc.iceConnectionState === 'disconnected')) {
              // console.log('[ICE] Menjalankan renegotiate...');
              peer.renegotiate();
            }
          }, 2000);
        }
      };
    }

    peer.on('connect', async () => {
      const handshakeDuration = Date.now() - startTime;
      // console.log(`[Handshake] Berhasil dalam ${handshakeDuration}ms`);
      if (handshakeDuration < 500) {
        // console.log('%c[Handshake] Ultra Cepat (<500ms)', 'color: #10b981; font-weight: bold');
      }

      setTransferState('transferring');
      transferStateRef.current = 'transferring';
      sendPeerJSON(peer, { type: 'batch-start', count: fileList.length });

      try {
        for (let i = 0; i < fileList.length; i++) {
          if (isCancelledRef.current) break;
          setCurrentFileIndex(i);
          const file = fileList[i];
          const hash = await calculateHash(file);
          
          const metadata = {
            name: file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream',
            hash
          };
          setCurrentFileMetadata(metadata);
          sendPeerJSON(peer, { type: 'metadata', ...metadata });

          await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
              let buffer = e.target.result;
            
            // Kompresi dinonaktifkan sesuai permintaan user
            const isCompressed = false; 

            let offset = 0;
              let chunkSize = MIN_CHUNK_SIZE;
              let lastProgressUpdate = 0;

              const sendChunk = async () => {
                try {
                  // Pipeline multiple chunks for higher throughput
                  const pipelineSize = 2; 
                  
                  while (offset < buffer.byteLength) {
                    if (isCancelledRef.current || peer.destroyed) {
                      reject(new Error('Transfer dibatalkan'));
                      return;
                    }

                    if (isPausedRef.current) {
                      setTimeout(sendChunk, 500);
                      return;
                    }

                    if (peer.bufferSize > BUFFER_THRESHOLD) {
                      const delay = Math.min(200, 20 + (peer.bufferSize / 1024 / 10));
                      setTimeout(sendChunk, delay);
                      return;
                    }

                    const promises = [];
                    for (let p = 0; p < pipelineSize && offset < buffer.byteLength; p++) {
                      const currentChunk = buffer.slice(offset, offset + chunkSize);
                      let dataToSend = currentChunk;

                      sendPeerBinary(peer, dataToSend);
                      offset += currentChunk.byteLength;
                      updateSpeed(currentChunk.byteLength);
                    }
                    
                    const currentProgress = (offset / buffer.byteLength) * 100;
                    
                    // Throttle sync messages (100ms) for high stability
                    if (Date.now() - lastProgressUpdate > 100 || offset >= buffer.byteLength) {
                      setProgress(currentProgress);
                      setProcessedSize(offset);
                      const currentSpeed = speedRef.current.currentSpeed;
                      const etaResult = calculateETA(buffer.byteLength, offset, currentSpeed);
                      
                      // Tracking & Logging performa estimasi
                      if (Math.abs(etaResult.seconds - lastEtaValueRef.current) > 10 && lastEtaValueRef.current !== 0) {
                        console.log(`[Performance] ETA Berubah Signifikan: ${lastEtaValueRef.current}s -> ${etaResult.seconds}s (Speed: ${formatSpeed(currentSpeed)})`);
                      }
                      lastEtaValueRef.current = etaResult.seconds;
                      setEta(etaResult.text);
                      
                      sendPeerJSON(peer, { 
                        type: 'progress', 
                        progress: currentProgress, 
                        processed: offset
                      });
                      lastProgressUpdate = Date.now();
                    }

                    if (offset >= buffer.byteLength) {
                      // Gunakan metadata hash yang dihitung sebelum pengiriman
                      sendPeerJSON(peer, { type: 'control', action: 'eof', hash: hash });
                    }
                    
                    // Yield to UI thread occasionally
                    if (offset % (chunkSize * 10) === 0) {
                      await new Promise(r => setTimeout(r, 0));
                    }
                  }
                  resolve();
                } catch (err) {
                  reject(err);
                }
              };
              sendChunk();
            };
            reader.readAsArrayBuffer(file);
          });
        }
      } catch (err) {
        if (err.message !== 'Transfer dibatalkan') {
          console.error('Transfer error:', err);
          toast.error('Terjadi kesalahan saat transfer');
        }
        return; // Exit if error or cancelled
      }

      if (!isCancelledRef.current) {
        setTransferState('completed');
        transferStateRef.current = 'completed';
        
        // Notify receiver that sender is finished
        sendPeerJSON(peerRef.current, { type: 'control', action: 'sender-finished' });

        // Sender: Wait for receiver to finish downloading
        toast.loading('Menunggu penerima selesai mendownload...', { id: 'sync-toast' });
        
        setHistory(prev => [{
          id: Date.now(),
          type: 'sent',
          to: targetUser.name,
          files: fileList.length,
          size: fileList.reduce((acc, f) => acc + f.size, 0),
          time: new Date().toLocaleTimeString()
        }, ...prev]);
        setFileList([]);
      }
    });

    peer.on('data', (data) => {
      const parsed = parseMessage(data);
      if (parsed.type === 'json') {
        const msg = parsed.message;
        if (msg.type === 'control') {
          if (msg.action === 'pause') { isPausedRef.current = true; setIsPaused(true); }
          if (msg.action === 'resume') { isPausedRef.current = false; setIsPaused(false); }
          if (msg.action === 'cancel') { handleCancelTransfer(false); }
          if (msg.action === 'receiver-finished') {
            toast.success('Penerima selesai mendownload! Memuat ulang...', { id: 'sync-toast' });
            setTimeout(() => window.location.reload(), 3000);
          }
        }
      }
    });

    peer.on('error', (err) => {
      console.error(`[Peer Error] Attempt ${retryAttempt + 1}:`, err);
      
      // Handshake Retry Mechanism with Exponential Backoff
      if (transferStateRef.current === 'connecting' && retryAttempt < MAX_RETRIES && !isCancelledRef.current) {
        const backoffDelay = Math.pow(2, retryAttempt) * 1000;
        console.log(`[Handshake] Gagal, mencoba ulang (Retry ${retryAttempt + 1}) dalam ${backoffDelay}ms...`);
        setTimeout(() => startTransfer(retryAttempt + 1), backoffDelay);
        return;
      }

      // Notify other peer via Signaling before refreshing
      if (socket && targetUser) {
        socket.emit('signal', { to: targetUser.id, from: me, signal: { type: 'control', action: 'force-refresh' } });
      }

      // Attempt ICE Restart on connection failure if transferring
      if (transferStateRef.current === 'transferring' && !isCancelledRef.current) {
        console.log('[ICE] Attempting ICE Restart...');
        peer.renegotiate();
        
        // If still error after timeout, force refresh
        setTimeout(() => {
          if (transferStateRef.current !== 'completed' && !isCancelledRef.current) {
            toast.error('Koneksi terputus secara permanen. Memuat ulang...');
            setTimeout(() => window.location.reload(), 2000);
          }
        }, 8000);
      } else {
        setTransferState('error');
        transferStateRef.current = 'error';
        toast.error('Gagal mengirim file: Koneksi bermasalah. Memuat ulang...');
        setTimeout(() => window.location.reload(), 3000);
      }
    });
    
    peer.on('close', () => {
      if (transferStateRef.current === 'transferring' && !isCancelledRef.current) {
        console.log('[Peer] Connection closed unexpectedly during transfer');
        
        // Notify other peer via Signaling before refreshing
        if (socket && targetUser) {
          socket.emit('signal', { to: targetUser.id, from: me, signal: { type: 'control', action: 'force-refresh' } });
        }

        toast.error('Koneksi ditutup. Memuat ulang...');
        setTimeout(() => window.location.reload(), 2000);
      }
    });
  };

  const handlePauseResume = () => {
    const newState = !isPaused;
    setIsPaused(newState);
    isPausedRef.current = newState;
    sendPeerJSON(peerRef.current, { type: 'control', action: newState ? 'pause' : 'resume' });
  };

  const handleCancelTransfer = (notifyPeer = true) => {
    isCancelledRef.current = true;
    
    // 1. Notify via Data Channel (Fastest)
    if (notifyPeer) {
      sendPeerJSON(peerRef.current, { type: 'control', action: 'cancel' });
    }
    
    // 2. Notify via Signaling (Reliable Fallback)
    if (notifyPeer && socket && targetUser) {
      socket.emit('signal', { to: targetUser.id, from: me, signal: { type: 'control', action: 'cancel' } });
    }

    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    
    setTransferState('idle');
    setProgress(0);
    setProcessedSize(0);
    toast.error('Transfer dibatalkan. Halaman akan dimuat ulang...');
    
    // Auto refresh after cancel
    setTimeout(() => {
      window.location.reload();
    }, 1500);
  };

  const declineTransfer = () => {
    if (incomingSignal) {
      const { from } = incomingSignal;
      socket.emit('signal', { 
        to: from, 
        from: me, 
        signal: { type: 'control', action: 'decline' } 
      });
      setIncomingSignal(null);
      toast.error('Transfer ditolak. Memuat ulang...');
      setTimeout(() => window.location.reload(), 1500);
    }
  };

  const acceptTransfer = () => {
    if (incomingSignal.pin && verifyPin !== incomingSignal.pin) {
      setPinError(true);
      toast.error('PIN yang dimasukkan salah!');
      return;
    }

    // console.log('[Accept] Starting transfer accept process...');
    setTransferState('transferring');
    transferStateRef.current = 'transferring';
    setTransferType('receiving');
    transferTypeRef.current = 'receiving';
    const { from, signal } = incomingSignal;
    setIncomingSignal(null);
    setVerifyPin('');
    setPinError(false);

    const peer = new Peer({
      initiator: false,
      trickle: true,
      config: PEER_CONFIG,
      allowHalfTrickle: true
    });

    peerRef.current = peer;
    isPausedRef.current = false;
    isCancelledRef.current = false;
    setIsPaused(false);
    setProcessedSize(0);

    peer.on('signal', (sig) => {
      // console.log(`[Accept Signal] type: ${sig?.type}`);
      if (sig.candidate) {
        const mode = detectConnectionType(sig.candidate.candidate);
        // console.log(`[Accept ICE Candidate] Found: ${mode}`);
        setConnectionMode(mode);
        
        // Share IP Gateway/Lokal secara eksplisit untuk mempercepat handshake
        if (sig.candidate.candidate.includes('typ host')) {
          const ipMatch = sig.candidate.candidate.match(/([0-9]{1,3}(\.[0-9]{1,3}){3})/);
          if (ipMatch) {
            // console.log(`[Direct IP] Sharing Gateway/Local IP: ${ipMatch[1]}`);
            socket.emit('signal', { 
              to: from, 
              from: me, 
              signal: { type: 'control', action: 'direct-ip', ip: ipMatch[1] } 
            });
          }
        }
      }
      
      // Cegah pengiriman sinyal ganda saat background
      if (peer.destroyed || isCancelledRef.current) return;
      emitSignal(socket, from, me, sig);
    });

    // Proactive ICE Connection State Monitoring for Receiver
    let receiverRenegotiateTimeout = null;
    if (peer._pc) {
      peer._pc.oniceconnectionstatechange = () => {
        const state = peer._pc.iceConnectionState;
        // console.log(`[Receiver ICE State] ${state}`);
        if (state === 'failed' || state === 'disconnected') {
           // console.warn('[Receiver ICE] Koneksi terhambat, menyiapkan negosiasi ulang...');
           if (receiverRenegotiateTimeout) clearTimeout(receiverRenegotiateTimeout);
           receiverRenegotiateTimeout = setTimeout(() => {
             if (peer._pc && (peer._pc.iceConnectionState === 'failed' || peer._pc.iceConnectionState === 'disconnected')) {
               // console.log('[Receiver ICE] Menjalankan renegotiate...');
               peer.renegotiate();
             }
           }, 2000);
        }
      };
    }

    let receivedChunks = [];
    let metadata = null;
    let receivedSize = 0;
    let totalFiles = 0;
    let currentFilesCount = 0;

    let isCompressed = false;

    let lastProgressTime = Date.now();
    let lastUIUpdateTime = 0; // Throttling UI updates for binary data

    peer.on('data', async (data) => {
      // Segera salin data ke buffer baru (Uint8Array) untuk integritas memori
      const rawData = new Uint8Array(data);
      const parsed = parseMessage(rawData);

      if (parsed.type === 'json') {
        const message = parsed.message;
        
        // --- LOGGING KOMPREHENSIF: JSON SIGNAL ---
        // console.log(`[Signal Received] Type: ${message.type}${message.action ? ', Action: ' + message.action : ''}`);

        if (message.type === 'batch-start') { 
          totalFiles = message.count; 
          return; 
        }
        if (message.type === 'metadata') {
          metadata = message;
          setCurrentFileMetadata(message);
          receivedChunks = [];
          receivedSize = 0;
          setProgress(0);
          setProcessedSize(0);
          setEta('--:--');
          isCompressed = false;
          speedRef.current = { bytes: 0, lastTime: Date.now(), window: [], currentSpeed: 0 };
          return;
        }
        if (message.type === 'control') {
          if (message.action === 'compressed') {
            isCompressed = true;
          } else if (message.action === 'pause') {
            isPausedRef.current = true;
            setIsPaused(true);
          } else if (message.action === 'resume') {
            isPausedRef.current = false;
            setIsPaused(false);
          } else if (message.action === 'cancel') {
            handleCancelTransfer(false);
          } else if (message.action === 'sender-finished') {
            toast.success('Pengirim selesai mengupload! Memuat ulang...', { id: 'sync-toast-receiver' });
            setTimeout(() => window.location.reload(), 3000);
          } else if (message.action === 'eof') {
            // Verifikasi integritas hash yang dikirim oleh pengirim
            if (message.hash) {
              // Simpan hash untuk divalidasi nanti di processReceivedFile
              metadata.expectedHash = message.hash;
            }
            processReceivedFile();
          }
          return;
        }
        if (message.type === 'progress') {
          lastProgressTime = Date.now();
          if (transferTypeRef.current === 'receiving') {
            setProgress(message.progress);
            setProcessedSize(message.processed);
            
            const currentSpeed = speedRef.current.currentSpeed;
            if (currentSpeed > 0 && metadata) {
              const etaResult = calculateETA(metadata.size, message.processed, currentSpeed);
              lastEtaValueRef.current = etaResult.seconds;
              setEta(etaResult.text);
            }
          } else {
            setProgress(message.progress);
            setProcessedSize(message.processed);
          }
          return;
        }
      }

      // Handle Binary Data (Chunk)
      // Gunakan data dari parsed (yang sudah dipotong header byte-nya)
      let chunkData = new Uint8Array(parsed.data);

      // CRITICAL: Push data yang sudah dipastikan Uint8Array
      receivedChunks.push(chunkData);
      const chunkSize = chunkData.byteLength;
      receivedSize += chunkSize;
      
      const currentLocalSpeed = updateSpeed(chunkSize);
      
      if (metadata) {
        const currentProgress = (receivedSize / metadata.size) * 100;
        if (transferTypeRef.current === 'receiving') {
          const now = Date.now();
          if (now - lastUIUpdateTime > 100 || receivedSize >= metadata.size || receivedSize <= chunkSize * 5) {
            setProgress(currentProgress);
            setProcessedSize(receivedSize);
            setTransferSpeed(currentLocalSpeed);
            const etaResult = calculateETA(metadata.size, receivedSize, currentLocalSpeed);
            if (etaResult.text !== '--:--') {
              lastEtaValueRef.current = etaResult.seconds;
              setEta(etaResult.text);
            }
            lastUIUpdateTime = now;
          }
        }
      }
    });

    const processReceivedFile = async () => {
      // Capture current metadata before it might be reset
      const fileMetadata = metadata;
      if (!fileMetadata || receivedChunks.length === 0) return;

      // console.log('Processing received file:', fileMetadata.name);
      let processedChunks = receivedChunks;
      if (isCompressed) {
        const combined = new Uint8Array(receivedSize);
        let offset = 0;
        receivedChunks.forEach(c => {
          combined.set(new Uint8Array(c), offset);
          offset += c.byteLength;
        });
        processedChunks = [decompressData(combined.buffer)];
      }

      // Verifikasi Integritas File (Hash Check)
      const blob = new Blob(processedChunks, { type: fileMetadata.mime });
      
      // Memberikan jeda sedikit agar memori tenang sebelum kalkulasi hash
      await new Promise(r => setTimeout(r, 300)); // Tambah jeda sedikit untuk kestabilan
      const currentHash = await calculateHash(blob);
      
      const expectedHash = fileMetadata.expectedHash || fileMetadata.hash;
      
      if (expectedHash && currentHash !== expectedHash) {
        console.error(`[Integrity Error] Hash mismatch for ${fileMetadata.name}`);
        console.error(`Expected: ${expectedHash}`);
        console.error(`Actual:   ${currentHash}`);
        
        toast.error(`File ${fileMetadata.name} korup saat pengiriman. Silakan coba lagi.`);
        // Reset and return without downloading
        metadata = null;
        receivedChunks = [];
        receivedSize = 0;
        return;
      }

      const url = URL.createObjectURL(blob);
      
      const fileName = fileMetadata.name;
      const fileSize = fileMetadata.size;

      // Langsung download file yang baru saja selesai
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Update received files state safely
      setReceivedFiles(prev => {
        const newFiles = [...prev, { name: fileName, url, size: fileSize }];
        
        currentFilesCount++;
        // console.log(`[Transfer] File selesai diproses (${currentFilesCount}/${totalFiles}): ${fileName}`);

        if (currentFilesCount >= totalFiles) {
          setTransferState('completed');
          transferStateRef.current = 'completed';
          
          // Receiver: Notify sender and wait
          sendPeerJSON(peerRef.current, { type: 'control', action: 'receiver-finished' });

          toast.success('Berhasil menerima semua file! Menunggu pengirim...', { id: 'sync-toast-receiver' });
          
          // Validasi Integritas Akhir (Log Hash)
          // console.log(`[Integrity] Semua file batch selesai. Total Size: ${formatSize(receivedSize)}`);

          setHistory(hPrev => [{
            id: Date.now(),
            type: 'received',
            from: users.find(u => u.id === from)?.name || 'Unknown',
            files: totalFiles,
            size: receivedSize,
            time: new Date().toLocaleTimeString()
          }, ...hPrev]);

          setTimeout(() => {
            window.location.reload();
          }, 3000);
        }
        return newFiles;
      });

      // Reset for next file in batch
      metadata = null;
      receivedChunks = [];
      receivedSize = 0;
    };

    peer.on('error', (err) => {
      console.error('[Receiver Peer Error]:', err);
      if (transferStateRef.current === 'transferring' && !isCancelledRef.current) {
        // Notify other peer via Signaling
        if (socket && from) {
          socket.emit('signal', { to: from, from: me, signal: { type: 'control', action: 'force-refresh' } });
        }
        toast.error('Koneksi terputus. Memuat ulang...');
        setTimeout(() => window.location.reload(), 2000);
      }
    });

    peer.on('close', () => {
      if (transferStateRef.current === 'transferring' && !isCancelledRef.current) {
        console.log('[Receiver Peer] Connection closed unexpectedly');
        // Notify other peer via Signaling
        if (socket && from) {
          socket.emit('signal', { to: from, from: me, signal: { type: 'control', action: 'force-refresh' } });
        }
        toast.error('Koneksi ditutup. Memuat ulang...');
        setTimeout(() => window.location.reload(), 2000);
      }
    });

    peer.signal(signal);
  };

  const handleSaveName = () => {
    if (tempName.trim()) {
      const newName = tempName.trim();
      setDisplayName(newName);
      setShowOnboarding(false);
      setIsEditingName(false);
      setTempName('');
      
      // Notify server about name change
      if (socket && isConnected) {
        socket.emit('join', {
          name: newName,
          deviceType: getDeviceInfo().isMobile ? 'mobile' : 'desktop',
          browser: getDeviceInfo().browser
        });
      }
    }
  };

  // --- Render Components ---
  return (
    <div className="min-h-screen bg-[#0a0c10] text-slate-200 font-sans selection:bg-blue-500/30 overflow-x-hidden">
      <Toaster 
        position="top-right" 
        toastOptions={{
          style: {
            background: '#0d1117',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '16px',
            fontSize: '14px',
            fontWeight: '600'
          }
        }}
      />
      {/* Background Decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-indigo-600/10 blur-[120px] rounded-full" />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 md:px-8 py-6">
        {/* Navigation / Header */}
        <header className="flex items-center justify-between mb-10">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 flex items-center justify-center overflow-hidden">
              <img src="/logo.png" alt="Logo" className="w-full h-full object-contain rounded-full" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-white">Kirim File</h1>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider">
                <span className={`flex h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                <span className={isConnected ? 'text-green-400' : 'text-red-400'}>
                  {isConnected ? 'Online' : 'Offline'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="flex items-center gap-2 group">
                {isEditingName ? (
                  <div className="flex items-center gap-2">
                    <input 
                      autoFocus
                      type="text"
                      value={tempName}
                      onChange={(e) => setTempName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                      className="bg-black/40 border border-blue-500/50 rounded-md px-2 py-0.5 text-xs text-white outline-none w-24"
                    />
                    <button onClick={handleSaveName} className="text-blue-500 hover:text-blue-400">
                      <CheckCircle size={14} />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col items-end">
                      <p className="text-xs font-semibold text-white">
                        <span className="hidden md:inline">Nama Perangkat : </span>
                        {displayName || 'Tanpa Nama'}
                      </p>
                    </div>
                    <button 
                      onClick={() => {setIsEditingName(true); setTempName(displayName);}}
                      className="text-slate-500 hover:text-blue-400 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <Edit2 size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              {/* Left Column: Device Discovery & Controls */}
              <div className="lg:col-span-4 space-y-6">
                <div className="bg-white/5 border border-white/10 rounded-3xl p-6 backdrop-blur-xl">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-sm font-bold text-white flex items-center gap-2">
                      <Globe size={18} className="text-blue-500" /> Perangkat Terhubung
                    </h2>
                  </div>

                  <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                    {users.length === 0 ? (
                      <div className="py-12 flex flex-col items-center text-center">
                        <div className="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center mb-4 animate-pulse">
                          <Search size={24} className="text-blue-500/50" />
                        </div>
                        <p className="text-sm text-slate-400 font-medium">Memindai perangkat...</p>
                        <p className="text-[11px] text-slate-600 mt-1 px-10">Pastikan perangkat lain membuka Kirim File di jaringan yang sama atau internet.</p>
                      </div>
                    ) : (
                      users.map((user) => (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          key={user.id}
                          onClick={() => setTargetUser(user)}
                          className={`group relative p-4 rounded-2xl border cursor-pointer transition-all duration-300 ${
                            targetUser?.id === user.id 
                              ? 'bg-blue-600 border-blue-400 shadow-xl shadow-blue-600/20' 
                              : 'bg-white/[0.03] border-white/5 hover:border-white/20 hover:bg-white/[0.06]'
                          }`}
                        >
                          <div className="flex items-center gap-4">
                            <div className={`w-12 h-12 rounded-xl flex items-center justify-center transition-colors ${
                              targetUser?.id === user.id ? 'bg-white/20' : 'bg-slate-800'
                            }`}>
                              {user.deviceType === 'mobile' ? <Smartphone size={22} /> : <Monitor size={22} />}
                            </div>
                            <div className="flex-1 overflow-hidden">
                              <h3 className={`font-bold text-sm truncate ${targetUser?.id === user.id ? 'text-white' : 'text-slate-200'}`}>
                                {user.name}
                              </h3>
                              <div className="flex items-center gap-2 mt-1">
                                <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-md ${
                                  targetUser?.id === user.id ? 'bg-white/20 text-white' : 'bg-slate-700/50 text-slate-400'
                                }`}>
                                  {user.deviceType === 'mobile' ? 'Mobile' : 'Desktop'}
                                </span>
                                <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-md animate-pulse ${
                                  user.isLocal 
                                    ? (targetUser?.id === user.id ? 'bg-white/30 text-white' : 'bg-green-500/20 text-green-400')
                                    : (targetUser?.id === user.id ? 'bg-white/30 text-white' : 'bg-green-500/20 text-green-400')
                                }`}>
                                  Online
                                </span>
                              </div>
                            </div>
                            {targetUser?.id === user.id && (
                              <div className="bg-white rounded-full p-1 text-blue-600">
                                <ChevronRight size={14} />
                              </div>
                            )}
                          </div>
                        </motion.div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Right Column: Main Interaction Area */}
              <div className="lg:col-span-8 space-y-6">
            <div className="bg-white/5 border border-white/10 rounded-[32px] p-8 backdrop-blur-xl relative overflow-hidden group">
              {/* Upload Illustration Background */}
              <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/5 blur-[80px] rounded-full -translate-y-1/2 translate-x-1/2 group-hover:bg-blue-500/10 transition-colors" />
              
              <div className="relative flex flex-col md:flex-row gap-8 items-start">
                <div className="flex-1 w-full">
                  <div 
                    onClick={() => fileInputRef.current.click()}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`group/drop relative border-2 border-dashed rounded-3xl p-10 flex flex-col items-center justify-center transition-all duration-500 cursor-pointer h-[400px] ${
                      isDragging 
                        ? 'border-blue-500 bg-blue-500/10 scale-[1.02]' 
                        : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-blue-500/50'
                    }`}
                  >
                    <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileSelect} multiple />
                    <div className="w-20 h-20 bg-gradient-to-br from-blue-500/20 to-indigo-600/20 rounded-2xl flex items-center justify-center mb-6 group-hover/drop:scale-110 transition-transform duration-500 ring-1 ring-white/10">
                      <FileUp size={40} className={isDragging ? 'text-white' : 'text-blue-500'} />
                    </div>
                    <h3 className="text-lg font-bold text-white mb-2">
                      {isDragging ? 'Lepaskan untuk Upload' : (getDeviceInfo().isMobile ? 'Klik And Browse' : 'Drop Or Click')}
                    </h3>
                    <p className="text-sm text-slate-500 max-w-[240px] text-center">Kirim File Anda Via P2P.</p>
                  </div>
                </div>

                    <div className="w-full md:w-80 flex flex-col justify-between h-[400px]">
                      <div className="bg-black/20 rounded-2xl p-5 border border-white/5">
                        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Ringkasan Pengiriman File</h3>
                        <div className="space-y-3">
                          <div className="flex justify-between items-center">
                            <span className="text-xs text-slate-500">File Terpilih</span>
                            <span className="text-sm font-bold text-white">{fileList.length} Item</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-xs text-slate-500">Total Ukuran</span>
                            <span className="text-sm font-bold text-white">{formatSize(fileList.reduce((acc, f) => acc + f.size, 0))}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-xs text-slate-500">Penerima</span>
                            <span className={`text-sm font-bold ${targetUser ? 'text-blue-400' : 'text-slate-600 italic'}`}>
                              {targetUser ? targetUser.name : 'Pilih Perangkat'}
                            </span>
                          </div>
                        </div>

                        {/* Secure Room PIN */}
                        <div className="mt-6 pt-4 border-t border-white/5">
                          <div className="flex items-center gap-3 mb-3">
                            <div className="p-2 bg-blue-500/10 rounded-lg">
                              <Lock size={16} className="text-blue-500" />
                            </div>
                            <div>
                              <p className="text-[11px] font-bold text-white leading-none">PIN Ruang Aman</p>
                              <p className="text-[9px] text-slate-500 mt-1">Hanya terhubung via PIN</p>
                            </div>
                          </div>
                          <input 
                            type="text" 
                            placeholder="Masukkan 4 digit PIN (Opsional)" 
                            maxLength={4}
                            value={roomPin}
                            onChange={(e) => setRoomPin(e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                          />
                        </div>
                      </div>

                      <button
                        disabled={fileList.length === 0 || !targetUser || transferState !== 'idle'}
                        onClick={() => startTransfer(0)}
                        className={`group relative w-full py-4 rounded-2xl font-bold text-lg transition-all duration-300 overflow-hidden ${
                          fileList.length === 0 || !targetUser || transferState !== 'idle'
                            ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-white/5'
                            : 'bg-blue-600 hover:bg-blue-500 text-white shadow-2xl shadow-blue-600/30 active:scale-95'
                        }`}
                      >
                        <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/10 to-white/0 -translate-x-full group-hover:animate-[shimmer_2s_infinite]" />
                        <div className="relative flex items-center justify-center gap-3">
                          {transferState === 'connecting' ? <Loader2 className="animate-spin" /> : <Share2 size={20} />}
                          {transferState === 'connecting' ? 'Membangun Koneksi P2P...' : 'Kirim File Sekarang'}
                        </div>
                      </button>
                    </div>
                  </div>
                </div>

                {/* File List Table */}
                {fileList.length > 0 && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-white/5 border border-white/10 rounded-3xl overflow-hidden backdrop-blur-xl"
                  >
                    <div className="px-6 py-4 border-b border-white/5 bg-white/[0.02] flex justify-between items-center">
                      <h3 className="text-sm font-bold text-white flex items-center gap-2">
                        <Files size={16} className="text-slate-400" /> Antrean Tertunda
                      </h3>
                      <button 
                        onClick={() => setFileList([])}
                        className="text-[10px] font-bold text-red-500/80 hover:text-red-500 uppercase tracking-wider flex items-center gap-1.5 transition-colors"
                      >
                        <Trash2 size={12} /> Hapus Semua
                      </button>
                    </div>
                    <div className="max-h-60 overflow-y-auto custom-scrollbar">
                      <table className="w-full text-left text-sm">
                        <tbody>
                          {fileList.map((f, i) => (
                            <tr key={i} className="group border-b border-white/[0.02] last:border-0 hover:bg-white/[0.02] transition-colors">
                              <td className="px-6 py-4 flex items-center gap-3 truncate max-w-[300px]">
                                <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center group-hover:bg-blue-500/20 transition-colors">
                                  <FileIcon size={14} className="text-slate-400 group-hover:text-blue-500" />
                                </div>
                                <span className="font-medium text-slate-300 truncate">{f.name}</span>
                              </td>
                              <td className="px-6 py-4 text-slate-500 text-xs">{formatSize(f.size)}</td>
                              <td className="px-6 py-4 text-right">
                                <button 
                                  onClick={() => removeFile(i)} 
                                  className="p-2 hover:bg-red-500/10 text-slate-600 hover:text-red-500 rounded-lg transition-colors"
                                >
                                  <X size={14} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </motion.div>
                )}
              </div>

          {/* Activity History Section at the Bottom */}
          <div className="lg:col-span-12 mt-12">
            <div className="bg-white/5 border border-white/10 rounded-[32px] p-8 backdrop-blur-xl">
              <div className="flex items-center justify-between mb-8">
                <div>
                  <h2 className="text-2xl font-black text-white">Riwayat Aktivitas</h2>
                  <p className="text-sm text-slate-500">Pantau pengiriman file P2P terakhir Anda</p>
                </div>
                <button 
                  onClick={() => setHistory([])}
                  className="px-4 py-2 bg-red-500/10 text-red-500 rounded-xl text-xs font-bold hover:bg-red-500/20 transition-all"
                >
                  Hapus Riwayat
                </button>
              </div>

              <div className="grid grid-cols-1 gap-4">
                {history.length === 0 ? (
                  <div className="py-20 text-center">
                    <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
                      <History size={32} className="text-slate-700" />
                    </div>
                    <p className="text-slate-500 font-medium">Tidak ada riwayat pengiriman</p>
                  </div>
                ) : (
                  history.map((item) => (
                    <div key={item.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 sm:p-5 rounded-2xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-all gap-4">
                      <div className="flex items-center gap-4 sm:gap-5">
                        <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl flex items-center justify-center shrink-0 ${item.type === 'sent' ? 'bg-blue-500/10 text-blue-500' : 'bg-green-500/10 text-green-500'}`}>
                          {item.type === 'sent' ? <Share2 size={20} className="sm:size-[24px]" /> : <Download size={20} className="sm:size-[24px]" />}
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-white text-base sm:text-lg truncate">
                            {item.type === 'sent' ? `Dikirim ke ${item.to}` : `Diterima dari ${item.from}`}
                          </p>
                          <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-1">
                            <span className="text-[10px] sm:text-xs text-slate-500 flex items-center gap-1">
                              <Files size={10} className="sm:size-[12px]" /> {item.files} file
                            </span>
                            <span className="text-[10px] sm:text-xs text-slate-500 flex items-center gap-1">
                              <Zap size={10} className="sm:size-[12px]" /> {formatSize(item.size)}
                            </span>
                            <span className="text-[10px] sm:text-xs text-slate-500 flex items-center gap-1">
                              <Clock size={10} className="sm:size-[12px]" /> {item.time}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-end sm:self-center">
                        <div className={`px-3 py-1 rounded-full text-[9px] sm:text-[10px] font-black uppercase tracking-wider ${item.type === 'sent' ? 'bg-blue-500/20 text-blue-400' : 'bg-green-500/20 text-green-400'}`}>
                          {item.type === 'sent' ? 'Dikirim' : 'Diterima'}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </main>

        {/* --- Overlays & Dialogs --- */}
        
        {/* Transfer Progress Overlay */}
        <AnimatePresence mode="wait">
          {(transferState === 'transferring' || transferState === 'connecting') && (
            <motion.div 
              key="transfer-overlay"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-[100] p-4"
            >
              <div className="bg-slate-900 border border-white/10 p-10 rounded-[40px] w-full max-w-md shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-white/5">
                  <motion.div 
                    initial={{ width: 0 }} animate={{ width: `${progress}%` }}
                    className="h-full bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]" 
                  />
                </div>
                
                <div className="text-center mb-8">
                  <div className="relative w-24 h-24 mx-auto mb-6">
                    <div className="absolute inset-0 bg-blue-500/20 rounded-full animate-ping" />
                    <div className="relative w-24 h-24 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center shadow-2xl">
                      {transferType === 'sending' ? <Share2 size={32} className="text-white" /> : <Download size={32} className="text-white" />}
                    </div>
                  </div>
                  <h3 className="text-2xl font-black text-white mb-2">
                    {transferType === 'sending' ? `Mengirim...` : 'Menerima...'}
                  </h3>
                  <p className="text-sm text-slate-400 font-medium truncate px-4">
                    {currentFileMetadata ? currentFileMetadata.name : 'Memproses data aliran'}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-2 font-bold uppercase tracking-widest">
                    {formatSize(processedBytes)} / {currentFileMetadata ? formatSize(currentFileMetadata.size) : '--'}
                  </p>
                  <p className="text-[9px] text-blue-400/60 mt-1 font-bold uppercase tracking-[0.2em]">
                    Estimasi: {eta}
                  </p>
                </div>

                <div className="flex flex-col gap-4 mb-8">
          <div className="bg-white/5 rounded-2xl p-6 border border-white/5 text-center w-full relative group">
            <p className="text-[10px] font-bold text-slate-500 uppercase mb-2">Kecepatan</p>
            <p className="text-3xl font-black text-blue-400">{formatSpeed(transferSpeed)}</p>
            {transferSpeed < 1024 * 10 && transferState === 'transferring' && (
              <div className="absolute top-2 right-2 flex items-center gap-1 text-[8px] font-bold text-yellow-500 animate-pulse bg-yellow-500/10 px-1.5 py-0.5 rounded">
                <AlertTriangle size={8} /> Jaringan Tidak Stabil
              </div>
            )}
          </div>
                  
                  <div className="flex gap-3">
                    <button 
                      onClick={handlePauseResume}
                      className="flex-1 bg-white/5 hover:bg-white/10 text-white py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all border border-white/10"
                    >
                      {isPaused ? <Zap size={18} className="text-yellow-400" /> : <Clock size={18} className="text-blue-400" />}
                      {isPaused ? 'Lanjut' : 'Jeda'}
                    </button>
                    <button 
                      onClick={() => handleCancelTransfer(true)}
                      className="flex-1 bg-red-500/10 hover:bg-red-500/20 text-red-500 py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all border border-red-500/20"
                    >
                      <X size={18} />
                      Batal
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 justify-center text-[10px] font-bold text-slate-600 uppercase tracking-widest">
                  Pengiriman P2P Aman
                </div>
              </div>
            </motion.div>
          )}

          {/* Incoming Transfer Request */}
          {incomingSignal && (
            <motion.div 
              key="incoming-request"
              initial={{ opacity: 0, y: 50, scale: 0.9 }} 
              animate={{ opacity: 1, y: 0, scale: 1 }} 
              exit={{ opacity: 0, scale: 0.9 }}
              className="fixed inset-0 md:inset-auto md:bottom-8 md:right-8 z-[150] flex items-center justify-center md:block p-4"
            >
              <div className="bg-slate-900 border-2 border-blue-500/50 p-6 rounded-[32px] shadow-2xl backdrop-blur-2xl w-full max-w-[360px] md:w-96">
                <div className="flex items-start gap-5 mb-6">
                  <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-600/20 ring-1 ring-white/20">
                    <Files size={28} className="text-white" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-black text-white leading-tight">Pengiriman Masuk</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      <span className="font-bold text-blue-400">{users.find(u => u.id === incomingSignal.from)?.name || 'Seseorang'}</span> ingin mengirimkan file kepada Anda.
                    </p>
                    {incomingSignal.pin && (
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center gap-1.5 text-[10px] font-bold text-green-500 bg-green-500/10 px-2 py-1 rounded-md w-fit">
                          <Lock size={10} /> DILINDUNGI PIN
                        </div>
                        <input 
                          type="text"
                          placeholder="Masukkan PIN"
                          maxLength={4}
                          value={verifyPin}
                          onChange={(e) => {
                            setVerifyPin(e.target.value);
                            setPinError(false);
                          }}
                          className={`w-full bg-black/40 border ${pinError ? 'border-red-500' : 'border-white/10'} rounded-xl px-4 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500/50 transition-colors`}
                        />
                        {pinError && <p className="text-[10px] text-red-500 font-bold">PIN tidak cocok!</p>}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-3">
                  <button 
                    onClick={acceptTransfer}
                    className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-2xl font-bold shadow-lg shadow-blue-600/20 active:scale-95 transition-all"
                  >
                    Terima
                  </button>
                  <button 
                    onClick={declineTransfer}
                    className="px-6 bg-slate-800 hover:bg-slate-700 text-slate-300 py-3 rounded-2xl font-bold active:scale-95 transition-all"
                  >
                    Tolak
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {/* Success Notification */}
          {receivedFiles.length > 0 && transferState === 'completed' && (
            <motion.div 
              key="success-notification"
              initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
              className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[80] w-full max-w-xl px-4"
            >
              <div className="bg-[#12141c] border-2 border-green-500/30 p-5 rounded-[32px] shadow-2xl overflow-hidden relative">
                <div className="absolute top-0 left-0 w-full h-1 bg-green-500" />
                <div className="flex items-center justify-between mb-4 px-2">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center">
                      <CheckCircle className="text-white" size={18} />
                    </div>
                    <span className="font-bold text-white">Menerima {receivedFiles.length} File</span>
                  </div>
                  <button onClick={() => {setReceivedFiles([]); setTransferState('idle');}} className="text-slate-500 hover:text-white p-1">
                    <X size={20} />
                  </button>
                </div>
                <div className="max-h-40 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                  {receivedFiles.map((rf, i) => (
                    <div key={i} className="bg-white/[0.03] p-3 rounded-2xl flex items-center justify-between gap-4 border border-white/5">
                      <div className="flex items-center gap-3 overflow-hidden">
                        <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center shrink-0">
                          <FileIcon size={14} className="text-blue-400" />
                        </div>
                        <div className="overflow-hidden">
                          <p className="font-bold text-xs text-white truncate">{rf.name}</p>
                          <p className="text-[10px] text-slate-500">{formatSize(rf.size)}</p>
                        </div>
                      </div>
                      <a 
                        href={rf.url} 
                        download={rf.name} 
                        onClick={() => {
                          setIsDownloadClicked(true);
                          setTimeout(() => {
                            window.location.reload();
                          }, 2000);
                        }}
                        className="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider shadow-lg shadow-blue-600/20 transition-all active:scale-95"
                      >
                        Download
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Onboarding Modal */}
        <AnimatePresence>
          {showOnboarding && (
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/90 backdrop-blur-xl flex items-center justify-center z-[200] p-4"
            >
              <div className="bg-slate-900 border border-white/10 p-10 rounded-[40px] w-full max-w-md shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 blur-3xl rounded-full" />
                <div className="relative text-center">
                  <div className="w-24 h-24 mx-auto mb-6 flex items-center justify-center overflow-hidden">
                    <img src="/logo.png" alt="Logo Welcome" className="w-full h-full object-contain rounded-full shadow-2xl" />
                  </div>
                  <h3 className="text-3xl font-black text-white mb-2">Selamat Datang!</h3>
                  <p className="text-sm text-slate-400 mb-8">Ayo buat nama tampilan untuk perangkat Anda agar orang lain dapat mengenali Anda.</p>
                  
                  <div className="space-y-4">
                    <div className="relative">
                      <input 
                        autoFocus
                        type="text"
                        placeholder="Masukkan nama tampilan..."
                        value={tempName}
                        onChange={(e) => setTempName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                        className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500 transition-all text-center font-bold"
                      />
                    </div>
                    <button 
                      disabled={!tempName.trim()}
                      onClick={handleSaveName}
                      className={`w-full py-4 rounded-2xl font-black text-lg transition-all ${
                        !tempName.trim() 
                          ? 'bg-slate-800 text-slate-500 cursor-not-allowed' 
                          : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20 active:scale-95'
                      }`}
                    >
                      Mulai Berbagi
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.02);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}

export default App;
