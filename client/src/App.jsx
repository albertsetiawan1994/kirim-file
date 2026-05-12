import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer/simplepeer.min.js';
import { 
  Monitor, Smartphone, FileUp, Download, X, CheckCircle, Loader2, 
  Wifi, Share2, Files, Trash2, FileIcon, ShieldCheck, History, 
  Settings, Info, Globe, Lock, Zap, Clock, AlertTriangle, ChevronRight,
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
  generateKey,
  encryptChunk,
  decryptChunk,
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
  const [activeTab, setActiveTab] = useState('transfer'); // transfer, history, settings
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
  const [isSecure, setIsSecure] = useState(true);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('userDisplayName') || '');
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('userDisplayName'));
  const [tempName, setTempName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [eta, setEta] = useState('--:--');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [verifyPin, setVerifyPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentFileMetadata, setCurrentFileMetadata] = useState(null);
  const [processedBytes, setProcessedSize] = useState(0);
  const [isDownloadClicked, setIsDownloadClicked] = useState(false);
  
  // --- Refs ---
  const peerRef = useRef();
  const fileInputRef = useRef();
  const speedRef = useRef({ bytes: 0, lastTime: Date.now(), window: [], currentSpeed: 0 });
  const encryptionKeyRef = useRef(null);
  const socketRef = useRef(null);
  const isPausedRef = useRef(false);
  const isCancelledRef = useRef(false);
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 3;

  // --- Socket Setup ---
  useEffect(() => {
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
      forceNew: true
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
      if (displayName) {
        newSocket.emit('join', {
          name: displayName,
          deviceType: getDeviceInfo().isMobile ? 'mobile' : 'desktop',
          browser: getDeviceInfo().browser
        });
      }
    });

    newSocket.on('users-list', (usersList) => {
      console.log('Received users list:', usersList);
      const updatedUsers = usersList.filter(u => u.id !== newSocket.id);
      setUsers(updatedUsers);
    });

    newSocket.on('signal', ({ from, signal, pin }) => {
      // Handle Control Signals (Cancel, Error, etc) via Signaling Fallback
      if (signal && signal.type === 'control') {
        if (signal.action === 'cancel' || signal.action === 'force-refresh') {
          const reason = signal.action === 'force-refresh' ? 'Koneksi lawan bermasalah' : 'Transfer dibatalkan';
          toast.error(`${reason}. Memuat ulang...`);
          setTimeout(() => window.location.reload(), 2000);
        }
        return;
      }

      if (signal.type === 'offer') {
        setIncomingSignal({ from, signal, pin });
      } else if (peerRef.current) {
        peerRef.current.signal(signal);
      }
    });

    newSocket.on('disconnect', () => setIsConnected(false));
    setSocket(newSocket);
    return () => newSocket.close();
  }, []);

  // Update Name in Signaling
  useEffect(() => {
    if (displayName) {
      localStorage.setItem('userDisplayName', displayName);
      
      // Sinkronisasi ke server jika socket sudah aktif
      if (socket && isConnected) {
        socket.emit('join', {
          name: displayName,
          deviceType: getDeviceInfo().isMobile ? 'mobile' : 'desktop',
          browser: getDeviceInfo().browser
        });
      }
    }
  }, [displayName, socket, isConnected]);

  // --- Effects ---
  useEffect(() => {
    localStorage.setItem('transferHistory', JSON.stringify(history.slice(0, 50)));
  }, [history]);

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

  const startTransfer = async () => {
    if (fileList.length === 0 || !targetUser) return;
    
    setTransferState('connecting');
    setTransferType('sending');
    isPausedRef.current = false;
    isCancelledRef.current = false;
    setIsPaused(false);
    setProcessedSize(0);
    
    // Generate Encryption Key if Secure
    if (isSecure) {
      const salt = Math.random().toString(36).substring(7);
      encryptionKeyRef.current = await generateKey('kirimfile-p2p', salt);
    }

    const peer = new Peer({
      initiator: true,
      trickle: true,
      config: PEER_CONFIG
    });

    peerRef.current = peer;

    peer.on('signal', (signal) => {
      if (signal.candidate) {
        const mode = detectConnectionType(signal.candidate.candidate);
        setConnectionMode(mode);
      }
      emitSignal(socket, targetUser.id, me, signal, { pin: roomPin });
    });

    peer.on('connect', async () => {
      setTransferState('transferring');
      peer.send(JSON.stringify({ type: 'batch-start', count: fileList.length, isSecure }));

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
          peer.send(JSON.stringify({ type: 'metadata', ...metadata }));

          await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
              let buffer = e.target.result;
            
            // Kompresi dinonaktifkan sesuai permintaan user
            const isCompressed = false; 

            let offset = 0;
              let chunkSize = 131072; // Start with 128KB for high speed
              let lastProgressUpdate = 0;

              const sendChunk = async () => {
                try {
                  // Pipeline multiple chunks for higher throughput
                  const pipelineSize = 4; 
                  
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

                      if (isSecure && encryptionKeyRef.current) {
                        const iv = window.crypto.getRandomValues(new Uint8Array(12));
                        const encrypted = await encryptChunk(encryptionKeyRef.current, currentChunk, iv);
                        const combined = new Uint8Array(iv.length + encrypted.byteLength);
                        combined.set(iv);
                        combined.set(new Uint8Array(encrypted), iv.length);
                        dataToSend = combined;
                      }

                      peer.send(dataToSend);
                      offset += currentChunk.byteLength;
                      updateSpeed(currentChunk.byteLength);
                    }
                    
                    const currentProgress = (offset / buffer.byteLength) * 100;
                    
                    // Throttle sync messages (100ms) for high stability
                    if (Date.now() - lastProgressUpdate > 100 || offset >= buffer.byteLength) {
                      setProgress(currentProgress);
                      setProcessedSize(offset);
                      const currentSpeed = speedRef.current.currentSpeed;
                      const currentEta = calculateETA(buffer.byteLength, offset, currentSpeed);
                      setEta(currentEta);
                      
                      peer.send(JSON.stringify({ 
                        type: 'progress', 
                        progress: currentProgress, 
                        processed: offset
                      }));
                      lastProgressUpdate = Date.now();
                    }

                    if (offset >= buffer.byteLength) {
                      peer.send(JSON.stringify({ type: 'control', action: 'eof', hash }));
                    }

                    // Faster chunk growth
                    if (peer.bufferSize < BUFFER_THRESHOLD / 2) {
                      chunkSize = Math.min(MAX_CHUNK_SIZE, chunkSize + 16384);
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
        toast.success('Semua file berhasil dikirim! Halaman akan dimuat ulang...');
        setHistory(prev => [{
          id: Date.now(),
          type: 'sent',
          to: targetUser.name,
          files: fileList.length,
          size: fileList.reduce((acc, f) => acc + f.size, 0),
          time: new Date().toLocaleTimeString()
        }, ...prev]);
        setFileList([]);

        // Auto refresh for sender after completion
        setTimeout(() => {
          window.location.reload();
        }, 3000);
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
        }
      }
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      
      // Notify other peer via Signaling before refreshing
      if (socket && targetUser) {
        socket.emit('signal', { to: targetUser.id, from: me, signal: { type: 'control', action: 'force-refresh' } });
      }

      // Attempt ICE Restart on connection failure if transferring
      if (transferState === 'transferring' && !isCancelledRef.current) {
        console.log('Attempting ICE Restart...');
        peer.renegotiate();
        
        // If still error after timeout, force refresh
        setTimeout(() => {
          if (transferState !== 'completed' && !isCancelledRef.current) {
            toast.error('Koneksi terputus secara permanen. Memuat ulang...');
            setTimeout(() => window.location.reload(), 2000);
          }
        }, 8000);
      } else {
        setTransferState('error');
        toast.error('Gagal mengirim file: Koneksi bermasalah. Memuat ulang...');
        setTimeout(() => window.location.reload(), 3000);
      }
    });
    
    peer.on('close', () => {
      if (transferState === 'transferring' && !isCancelledRef.current) {
        console.log('Peer connection closed unexpectedly during transfer');
        
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
    if (peerRef.current) {
      peerRef.current.send(JSON.stringify({ type: 'control', action: newState ? 'pause' : 'resume' }));
    }
  };

  const handleCancelTransfer = (notifyPeer = true) => {
    isCancelledRef.current = true;
    
    // 1. Notify via Data Channel (Fastest)
    if (notifyPeer && peerRef.current) {
      try { peerRef.current.send(JSON.stringify({ type: 'control', action: 'cancel' })); } catch(e) {}
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

  const acceptTransfer = () => {
    if (incomingSignal.pin && verifyPin !== incomingSignal.pin) {
      setPinError(true);
      toast.error('PIN yang dimasukkan salah!');
      return;
    }

    setTransferState('transferring');
    setTransferType('receiving');
    const { from, signal } = incomingSignal;
    setIncomingSignal(null);
    setVerifyPin('');
    setPinError(false);

    const peer = new Peer({
      initiator: false,
      trickle: true,
      config: PEER_CONFIG
    });

    peerRef.current = peer;
    isPausedRef.current = false;
    isCancelledRef.current = false;
    setIsPaused(false);
    setProcessedSize(0);

    peer.on('signal', (signal) => {
      if (signal.candidate) {
        const mode = detectConnectionType(signal.candidate.candidate);
        setConnectionMode(mode);
      }
      emitSignal(socket, from, me, signal);
    });

    let receivedChunks = [];
    let metadata = null;
    let receivedSize = 0;
    let totalFiles = 0;
    let currentFilesCount = 0;

    let isCompressed = false;

    let lastProgressTime = Date.now();
    let lastUIUpdateTime = 0; // Throttling UI updates for binary data

    peer.on('data', async (data) => {
      const parsed = parseMessage(data);

      if (parsed.type === 'json') {
        const message = parsed.message;
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
          setEta('--:--'); // Reset ETA to default
          isCompressed = false;
          // Reset speed calculation for new file
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
          } else if (message.action === 'eof') {
            console.log('EOF received for:', metadata?.name);
            processReceivedFile();
          }
          return;
        }
        if (message.type === 'progress') {
          lastProgressTime = Date.now();
          // Decoupled: Receiver only takes progress/processed as reference
          // but calculates its own speed and ETA locally for better accuracy
          if (transferType === 'receiving') {
            setProgress(message.progress);
            setProcessedSize(message.processed);
            
            // CRITICAL FIX: Jangan biarkan pesan progress tanpa ETA dari pengirim
            // meng-overwrite state ETA lokal penerima. 
            // Kita hitung ulang ETA di sini menggunakan kecepatan lokal.
            const currentSpeed = speedRef.current.currentSpeed;
            if (currentSpeed > 0 && metadata) {
              const localEta = calculateETA(metadata.size, message.processed, currentSpeed);
              if (localEta !== '--:--') setEta(localEta);
            }
          } else {
            // Sender updates from receiver's feedback if any (though currently one-way)
            setProgress(message.progress);
            setProcessedSize(message.processed);
          }
          return;
        }
      }

      // Handle Binary Data (Chunk)
      let chunkData = data;
      if (isSecure && encryptionKeyRef.current) {
        try {
          const iv = data.slice(0, 12);
          const encrypted = data.slice(12);
          chunkData = await decryptChunk(encryptionKeyRef.current, encrypted, iv);
        } catch (e) {
          console.error('Decryption failed', e);
        }
      }

      receivedChunks.push(chunkData);
      const chunkSize = chunkData.byteLength || chunkData.length;
      receivedSize += chunkSize;
      
      // Hitung kecepatan lokal secara real-time dari data biner yang masuk
      const currentLocalSpeed = updateSpeed(chunkSize);
      
      if (metadata) {
        const currentProgress = (receivedSize / metadata.size) * 100;
        // Receiver relies on local binary flow for speed and ETA
        if (transferType === 'receiving') {
          const now = Date.now();
          // Throttle UI updates (100ms) but ensure ETA is updated immediately at start
          if (now - lastUIUpdateTime > 100 || receivedSize >= metadata.size || receivedSize <= chunkSize * 5) {
            setProgress(currentProgress);
            setProcessedSize(receivedSize);
            setTransferSpeed(currentLocalSpeed);
            const newEta = calculateETA(metadata.size, receivedSize, currentLocalSpeed);
            if (newEta !== '--:--') setEta(newEta);
            lastUIUpdateTime = now;
          }
        }
      }
    });

    const processReceivedFile = async () => {
      // Capture current metadata before it might be reset
      const fileMetadata = metadata;
      if (!fileMetadata || receivedChunks.length === 0) return;

      console.log('Processing received file:', fileMetadata.name);
      let finalBuffer = receivedChunks;
      if (isCompressed) {
        const combined = new Uint8Array(receivedSize);
        let offset = 0;
        receivedChunks.forEach(c => {
          combined.set(new Uint8Array(c), offset);
          offset += c.byteLength;
        });
        finalBuffer = [decompressData(combined.buffer)];
      }

      const blob = new Blob(finalBuffer, { type: fileMetadata.mime });
      const url = URL.createObjectURL(blob);
      
      const fileName = fileMetadata.name;
      const fileSize = fileMetadata.size;

      // Update received files state safely
      setReceivedFiles(prev => {
        const newFiles = [...prev, { name: fileName, url, size: fileSize }];
        
        currentFilesCount++;
        if (currentFilesCount >= totalFiles) {
          setTransferState('completed');
          toast.success('Berhasil menerima semua file! Halaman akan dimuat ulang...');
          
          newFiles.forEach(file => {
            const a = document.createElement('a');
            a.href = file.url;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          });

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
      console.error('Receiver Peer error:', err);
      if (transferState === 'transferring' && !isCancelledRef.current) {
        // Notify other peer via Signaling
        if (socket && from) {
          socket.emit('signal', { to: from, from: me, signal: { type: 'control', action: 'force-refresh' } });
        }
        toast.error('Koneksi terputus. Memuat ulang...');
        setTimeout(() => window.location.reload(), 2000);
      }
    });

    peer.on('close', () => {
      if (transferState === 'transferring' && !isCancelledRef.current) {
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
                  {isConnected ? `${connectionMode}` : 'CONNECTING...'}
                </span>
              </div>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-6">
            <nav className="flex items-center gap-1 p-1 bg-white/5 rounded-xl border border-white/10">
              <button 
                onClick={() => setActiveTab('transfer')}
                className={`px-4 py-2 text-sm font-medium rounded-lg shadow-sm transition-all ${activeTab === 'transfer' ? 'bg-blue-500 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                Transfer
              </button>
              <button 
                onClick={() => setActiveTab('history')}
                className={`px-4 py-2 text-sm font-medium rounded-lg shadow-sm transition-all ${activeTab === 'history' ? 'bg-blue-500 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                History
              </button>
            </nav>
            <div className="h-8 w-[1px] bg-white/10" />
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
                        <p className="text-xs font-semibold text-white">{displayName || 'Anonymous'}</p>
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
          </div>
          
          <button 
            onClick={() => setIsMobileMenuOpen(true)}
            className="md:hidden p-2 text-slate-400 hover:text-white transition-colors"
          >
            <Menu size={24} />
          </button>
        </header>

        {/* Mobile Sidebar */}
        <AnimatePresence>
          {isMobileMenuOpen && (
            <>
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsMobileMenuOpen(false)}
                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[150] md:hidden"
              />
              <motion.div 
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="fixed top-0 right-0 bottom-0 w-[280px] bg-[#0d1117] border-l border-white/10 z-[151] md:hidden p-6 shadow-2xl"
              >
                <div className="flex items-center justify-between mb-8">
                  <h2 className="text-xl font-bold text-white">Menu</h2>
                  <button onClick={() => setIsMobileMenuOpen(false)} className="p-2 text-slate-400">
                    <X size={24} />
                  </button>
                </div>
                
                <div className="space-y-4">
                  <button 
                    onClick={() => { setActiveTab('transfer'); setIsMobileMenuOpen(false); }}
                    className={`w-full flex items-center gap-4 p-4 rounded-2xl font-bold transition-all ${activeTab === 'transfer' ? 'bg-blue-600 text-white' : 'bg-white/5 text-slate-400'}`}
                  >
                    <Share2 size={20} /> Transfer
                  </button>
                  <button 
                    onClick={() => { setActiveTab('history'); setIsMobileMenuOpen(false); }}
                    className={`w-full flex items-center gap-4 p-4 rounded-2xl font-bold transition-all ${activeTab === 'history' ? 'bg-blue-600 text-white' : 'bg-white/5 text-slate-400'}`}
                  >
                    <History size={20} /> History
                  </button>
                </div>

                <div className="absolute bottom-8 left-6 right-6">
                  <div className="p-4 bg-white/5 rounded-2xl border border-white/10">
                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">My Device</p>
                    <div className="flex items-center justify-between group">
                      {isEditingName ? (
                        <div className="flex items-center gap-1 w-full">
                          <input 
                            autoFocus
                            type="text"
                            value={tempName}
                            onChange={(e) => setTempName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                            className="bg-black/40 border border-blue-500/50 rounded-md px-2 py-1 text-sm text-white outline-none flex-1"
                          />
                          <button onClick={handleSaveName} className="text-blue-500">
                            <CheckCircle size={18} />
                          </button>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm font-bold text-white truncate flex-1">{displayName || 'Anonymous'}</p>
                          <button 
                            onClick={() => {setIsEditingName(true); setTempName(displayName);}}
                            className="text-slate-500 hover:text-blue-400 p-1"
                          >
                            <Edit2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {activeTab === 'transfer' && (
            <>
              {/* Left Column: Device Discovery & Controls */}
              <div className="lg:col-span-4 space-y-6">
                <div className="bg-white/5 border border-white/10 rounded-3xl p-6 backdrop-blur-xl">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-sm font-bold text-white flex items-center gap-2">
                      <Globe size={18} className="text-blue-500" /> Nearby Devices
                    </h2>
                  </div>

                  <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                    {users.length === 0 ? (
                      <div className="py-12 flex flex-col items-center text-center">
                        <div className="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center mb-4 animate-pulse">
                          <Search size={24} className="text-blue-500/50" />
                        </div>
                        <p className="text-sm text-slate-400 font-medium">Scanning for devices...</p>
                        <p className="text-[11px] text-slate-600 mt-1 px-10">Make sure others have Kirim File open on the same network or internet.</p>
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
                                  {user.deviceType}
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

                {/* Quick Settings */}
                <div className="bg-white/5 border border-white/10 rounded-3xl p-6 backdrop-blur-xl">
                  <h2 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                    <Settings size={18} className="text-slate-400" /> Transfer Settings
                  </h2>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-green-500/10 rounded-lg">
                          <ShieldCheck size={18} className="text-green-500" />
                        </div>
                        <div>
                          <p className="text-xs font-bold text-white">E2E Encryption</p>
                          <p className="text-[10px] text-slate-500">AES-256 GCM Secure</p>
                        </div>
                      </div>
                      <button 
                        onClick={() => setIsSecure(!isSecure)}
                        className={`w-10 h-5 rounded-full transition-colors relative ${isSecure ? 'bg-blue-500' : 'bg-slate-700'}`}
                      >
                        <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${isSecure ? 'right-1' : 'left-1'}`} />
                      </button>
                    </div>
                    
                    <div className="pt-4 border-t border-white/5">
                      <div className="flex items-center gap-3 mb-3">
                        <div className="p-2 bg-blue-500/10 rounded-lg">
                          <Lock size={18} className="text-blue-500" />
                        </div>
                        <div>
                          <p className="text-xs font-bold text-white">Secure Room PIN</p>
                          <p className="text-[10px] text-slate-500">Only connect via PIN</p>
                        </div>
                      </div>
                      <input 
                        type="text" 
                        placeholder="Enter 4-digit PIN (Optional)" 
                        maxLength={4}
                        value={roomPin}
                        onChange={(e) => setRoomPin(e.target.value)}
                        className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                      />
                    </div>
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
                    className={`group/drop relative border-2 border-dashed rounded-3xl p-10 flex flex-col items-center justify-center transition-all duration-500 cursor-pointer h-72 ${
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
                      {isDragging ? 'Lepaskan untuk Upload' : 'Drop files here or click'}
                    </h3>
                    <p className="text-sm text-slate-500 max-w-[240px] text-center">Select files or folders to transfer instantly via P2P.</p>
                  </div>
                </div>

                    <div className="w-full md:w-80 flex flex-col justify-between h-72">
                      <div className="bg-black/20 rounded-2xl p-5 border border-white/5">
                        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Transfer Summary</h3>
                        <div className="space-y-3">
                          <div className="flex justify-between items-center">
                            <span className="text-xs text-slate-500">Selected Files</span>
                            <span className="text-sm font-bold text-white">{fileList.length} Items</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-xs text-slate-500">Total Volume</span>
                            <span className="text-sm font-bold text-white">{formatSize(fileList.reduce((acc, f) => acc + f.size, 0))}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-xs text-slate-500">Recipient</span>
                            <span className={`text-sm font-bold ${targetUser ? 'text-blue-400' : 'text-slate-600 italic'}`}>
                              {targetUser ? targetUser.name : 'Select Device'}
                            </span>
                          </div>
                        </div>
                      </div>

                      <button
                        disabled={fileList.length === 0 || !targetUser || transferState !== 'idle'}
                        onClick={startTransfer}
                        className={`group relative w-full py-4 rounded-2xl font-bold text-lg transition-all duration-300 overflow-hidden ${
                          fileList.length === 0 || !targetUser || transferState !== 'idle'
                            ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-white/5'
                            : 'bg-blue-600 hover:bg-blue-500 text-white shadow-2xl shadow-blue-600/30 active:scale-95'
                        }`}
                      >
                        <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/10 to-white/0 -translate-x-full group-hover:animate-[shimmer_2s_infinite]" />
                        <div className="relative flex items-center justify-center gap-3">
                          {transferState === 'connecting' ? <Loader2 className="animate-spin" /> : <Share2 size={20} />}
                          {transferState === 'connecting' ? 'Establishing P2P...' : 'Send Files Now'}
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
                        <Files size={16} className="text-slate-400" /> Pending Queue
                      </h3>
                      <button 
                        onClick={() => setFileList([])}
                        className="text-[10px] font-bold text-red-500/80 hover:text-red-500 uppercase tracking-wider flex items-center gap-1.5 transition-colors"
                      >
                        <Trash2 size={12} /> Clear All
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
            </>
          )}

          {activeTab === 'history' && (
            <div className="lg:col-span-12">
              <div className="bg-white/5 border border-white/10 rounded-[32px] p-8 backdrop-blur-xl">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h2 className="text-2xl font-black text-white">Activity History</h2>
                    <p className="text-sm text-slate-500">Track your recent P2P file transfers</p>
                  </div>
                  <button 
                    onClick={() => setHistory([])}
                    className="px-4 py-2 bg-red-500/10 text-red-500 rounded-xl text-xs font-bold hover:bg-red-500/20 transition-all"
                  >
                    Clear History
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-4">
                  {history.length === 0 ? (
                    <div className="py-20 text-center">
                      <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
                        <History size={32} className="text-slate-700" />
                      </div>
                      <p className="text-slate-500 font-medium">No transfer history found</p>
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
                              {item.type === 'sent' ? `Sent to ${item.to}` : `Received from ${item.from}`}
                            </p>
                            <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-1">
                              <span className="text-[10px] sm:text-xs text-slate-500 flex items-center gap-1">
                                <Files size={10} className="sm:size-[12px]" /> {item.files} files
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
                            {item.type}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
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
                    {transferType === 'sending' ? `Sending...` : 'Receiving...'}
                  </h3>
                  <p className="text-sm text-slate-400 font-medium truncate px-4">
                    {currentFileMetadata ? currentFileMetadata.name : 'Processing stream data'}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-2 font-bold uppercase tracking-widest">
                    {formatSize(processedBytes)} / {currentFileMetadata ? formatSize(currentFileMetadata.size) : '--'}
                  </p>
                  <p className="text-[9px] text-blue-400/60 mt-1 font-bold uppercase tracking-[0.2em]">
                    ETA: {eta}
                  </p>
                </div>

                <div className="flex flex-col gap-4 mb-8">
                  <div className="bg-white/5 rounded-2xl p-6 border border-white/5 text-center w-full">
                    <p className="text-[10px] font-bold text-slate-500 uppercase mb-2">Kecepatan</p>
                    <p className="text-3xl font-black text-blue-400">{formatSpeed(transferSpeed)}</p>
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
                  <ShieldCheck size={12} className="text-green-500" /> End-to-End Encrypted
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
                    <h3 className="text-lg font-black text-white leading-tight">Incoming Transfer</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      <span className="font-bold text-blue-400">{users.find(u => u.id === incomingSignal.from)?.name || 'Someone'}</span> wants to send you files.
                    </p>
                    {incomingSignal.pin && (
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center gap-1.5 text-[10px] font-bold text-green-500 bg-green-500/10 px-2 py-1 rounded-md w-fit">
                          <Lock size={10} /> PIN PROTECTED
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
                    Accept
                  </button>
                  <button 
                    onClick={() => setIncomingSignal(null)}
                    className="px-6 bg-slate-800 hover:bg-slate-700 text-slate-300 py-3 rounded-2xl font-bold active:scale-95 transition-all"
                  >
                    Decline
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
                    <span className="font-bold text-white">Received {receivedFiles.length} Files</span>
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
                  <h3 className="text-3xl font-black text-white mb-2">Welcome!</h3>
                  <p className="text-sm text-slate-400 mb-8">Let's set a display name for your device so others can identify you.</p>
                  
                  <div className="space-y-4">
                    <div className="relative">
                      <input 
                        autoFocus
                        type="text"
                        placeholder="Enter display name..."
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
                      Start Sharing
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
