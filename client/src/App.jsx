import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer/simplepeer.min.js';
import { UAParser } from 'ua-parser-js';
import { 
  Monitor, 
  Smartphone, 
  FileUp, 
  Download, 
  X, 
  CheckCircle, 
  Loader2, 
  Wifi,
  Share2,
  Files,
  Trash2,
  FileIcon,
  ShieldCheck,
  User,
  Edit2,
  History,
  Clock
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const GLOBAL_SIGNALING_URL = 'https://kirim-file.onrender.com'; 

function App() {
  const [socket, setSocket] = useState(null);
  const [me, setMe] = useState('');
  const [users, setUsers] = useState([]);
  const [targetUser, setTargetUser] = useState(null);
  const [fileList, setFileList] = useState([]);
  const [sending, setSending] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [currentFileName, setCurrentFileName] = useState('');
  const [progress, setProgress] = useState(0);
  const [receivedFiles, setReceivedFiles] = useState([]);
  const [history, setHistory] = useState(JSON.parse(localStorage.getItem('transferHistory')) || []);
  const [incomingSignal, setIncomingSignal] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [transferSpeed, setTransferSpeed] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const itemsPerPage = 15;
  const speedRef = useRef({ bytes: 0, lastTime: Date.now() });
  const lastProgressUpdateRef = useRef(0);
  const lastProgressSignalRef = useRef(0);
  const lastSenderProgressAtRef = useRef(0);
  const [userName, setUserName] = useState(localStorage.getItem('userName') || '');
  const [tempName, setTempName] = useState(localStorage.getItem('userName') || '');
  const [isEditingName, setIsEditingName] = useState(!localStorage.getItem('userName'));
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { index, name }
  const [deleteAllConfirm, setDeleteAllConfirm] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const [systemMessage, setSystemMessage] = useState('');
  const [retryAttempt, setRetryAttempt] = useState(0);
  
  const peerRef = useRef();
  const remotePeerIdRef = useRef(null);
  const remoteCancelledRef = useRef(false);
  const fileInputRef = useRef();
  const cancelBtnRef = useRef(null);
  const confirmBtnRef = useRef(null);
  const dialogFocusRef = useRef('cancel');

  useEffect(() => {
    localStorage.setItem('transferHistory', JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    const isDialogOpen = Boolean(deleteConfirm) || deleteAllConfirm;
    if (!isDialogOpen) return;
    if (!window.matchMedia('(min-width: 768px)').matches) return;

    dialogFocusRef.current = 'cancel';
    setTimeout(() => {
      cancelBtnRef.current?.focus?.();
    }, 0);

    const onKeyDown = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = dialogFocusRef.current === 'cancel' ? 'confirm' : 'cancel';
        dialogFocusRef.current = next;
        if (next === 'cancel') cancelBtnRef.current?.focus?.();
        else confirmBtnRef.current?.focus?.();
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (document.activeElement === cancelBtnRef.current) {
          setDeleteConfirm(null);
          setDeleteAllConfirm(false);
          return;
        }
        if (document.activeElement === confirmBtnRef.current) {
          if (deleteAllConfirm) handleDeleteAllHistory();
          else handleDeleteHistory();
          return;
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        setDeleteConfirm(null);
        setDeleteAllConfirm(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteConfirm, deleteAllConfirm]);

  useEffect(() => {
    const newSocket = io(GLOBAL_SIGNALING_URL, {
      transports: ['websocket'],
      secure: true
    });

    newSocket.on('connect', () => {
      setMe(newSocket.id);
      setIsConnected(true);
      const parser = new UAParser();
      const result = parser.getResult();
      const deviceType = isMobile() ? 'Mobile' : 'Desktop';
      newSocket.emit('join', {
        name: userName,
        deviceInfo: deviceType,
        deviceType: deviceType
      });
    });

    newSocket.on('users-list', (usersList) => {
      setUsers(usersList.filter(u => u.id !== newSocket.id));
    });

    newSocket.on('signal', ({ from, signal }) => {
      if (signal.type === 'offer') {
        setIncomingSignal({ from, signal });
        return;
      }
      if (signal.type === 'cancel') {
        remoteCancelledRef.current = true;
        remotePeerIdRef.current = from;
        if (peerRef.current) {
          try { peerRef.current.destroy(); } catch (e) {}
          peerRef.current = null;
        }
        window.location.reload();
        return;
      }
      if (peerRef.current) {
        peerRef.current.signal(signal);
      }
    });

    newSocket.on('disconnect', () => setIsConnected(false));
    setSocket(newSocket);
    return () => newSocket.close();
  }, [userName]);

  useEffect(() => {
    if (receiving && incomingSignal) {
      acceptTransfer(incomingSignal, true);
    }
  }, [receiving, incomingSignal]);

  const isMobile = () => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  const handleFileSelect = (e) => {
    const selectedFiles = Array.from(e.target.files);
    if (selectedFiles.length > 0) {
      setFileList(prev => [...prev, ...selectedFiles]);
    }
  };

  const removeFile = (index) => setFileList(prev => prev.filter((_, i) => i !== index));

  const formatSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const updateSpeed = (bytesSent) => {
    const now = Date.now();
    speedRef.current.bytes += bytesSent;
    const timeDiff = (now - speedRef.current.lastTime) / 1000;
    
    if (timeDiff >= 1) {
      setTransferSpeed(speedRef.current.bytes / timeDiff);
      speedRef.current.bytes = 0;
      speedRef.current.lastTime = now;
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const startTransfer = async () => {
    if (fileList.length === 0 || !targetUser) return;
    setSending(true);
    setIsCancelled(false);
    setSystemMessage('');
    setRetryAttempt(0);
    setTotalFiles(fileList.length);
    remotePeerIdRef.current = targetUser.id;
    remoteCancelledRef.current = false;
    setCurrentFileIndex(0);
    setCurrentFileName(fileList[0]?.name || '');
    const totalBytesAll = fileList.reduce((acc, f) => acc + (f.size || 0), 0);
    setTotalBytes(totalBytesAll);
    const prefixBytes = [];
    let running = 0;
    for (const f of fileList) {
      prefixBytes.push(running);
      running += (f.size || 0);
    }

    const sendFileOverPeer = (peer, file, baseBytes, fileIndex) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read-error'));
      reader.onload = (e) => {
        const buffer = e.target.result;
        let offset = 0;
        const chunkSize = 262144;
        const bufferLimit = 12 * 1024 * 1024;

        if (peer.destroyed || !peer.connected) {
          reject(new Error('peer-not-connected'));
          return;
        }

        try {
          peer.send(JSON.stringify({
            type: 'metadata',
            name: file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream'
          }));
        } catch (err) {
          reject(err);
          return;
        }

        const sendNextChunk = () => {
          if (peer.destroyed || !peer.connected) {
            reject(new Error('peer-disconnected'));
            return;
          }

          try {
            while (offset < buffer.byteLength) {
              if (peer.bufferSize > bufferLimit) {
                setTimeout(sendNextChunk, 1);
                return;
              }

              const chunk = buffer.slice(offset, offset + chunkSize);
              peer.send(chunk);
              offset += chunk.byteLength;
              updateSpeed(chunk.byteLength);
              const now = Date.now();
              if (now - lastProgressUpdateRef.current > 50 || offset >= buffer.byteLength) {
                lastProgressUpdateRef.current = now;
                const denom = totalBytesAll || buffer.byteLength;
                const sentBytes = baseBytes + offset;
                setProgress(Math.min(100, (sentBytes / denom) * 100));
                if (now - lastProgressSignalRef.current > 80 || offset >= buffer.byteLength) {
                  lastProgressSignalRef.current = now;
                  try {
                    peer.send(JSON.stringify({
                      type: 'progress',
                      sentBytes,
                      totalBytes: totalBytesAll,
                      fileIndex,
                      fileName: file.name
                    }));
                  } catch (e) {}
                }
              }
            }
            setSystemMessage('');
            resolve();
          } catch (err) {
            if (err.name === 'OperationError' || String(err?.message || '').includes('full')) {
              setTimeout(sendNextChunk, 10);
              return;
            }
            reject(err);
          }
        };

        setTimeout(sendNextChunk, 50);
      };
      reader.readAsArrayBuffer(file);
    });

    let startIndex = 0;
    while (startIndex < fileList.length) {
      if (remoteCancelledRef.current) {
        break;
      }
      const result = await new Promise((resolve) => {
        let currentIndex = startIndex;
        const peer = new Peer({
          initiator: true,
          trickle: true,
          config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
        });

        peerRef.current = peer;
        const connectMsgTimer = setTimeout(() => {
          setSystemMessage('Sistem: Menghubungkan ke perangkat penerima...');
        }, 400);

        peer.on('signal', (signal) => {
          socket.emit('signal', { to: targetUser.id, from: me, signal });
        });

        const connectTimeout = setTimeout(() => {
          clearTimeout(connectMsgTimer);
          setRetryAttempt((a) => a + 1);
          setSystemMessage('Sistem: Menunggu penerima menyetujui, mencoba ulang...');
          try { peer.destroy(); } catch (e) {}
          if (peerRef.current === peer) peerRef.current = null;
          resolve({ retry: true, index: currentIndex });
        }, 8000);

        peer.on('connect', async () => {
          clearTimeout(connectTimeout);
          clearTimeout(connectMsgTimer);
          setSystemMessage('');
          setTransferSpeed(0);
          speedRef.current = { bytes: 0, lastTime: Date.now() };
          try {
            peer.send(JSON.stringify({ type: 'batch-start', count: fileList.length, totalBytes: totalBytesAll }));
          } catch (e) {
            setRetryAttempt((a) => a + 1);
            setSystemMessage('Sistem: Gagal memulai pengiriman, mencoba ulang...');
            try { peer.destroy(); } catch (x) {}
            if (peerRef.current === peer) peerRef.current = null;
            resolve({ retry: true, index: currentIndex });
            return;
          }

          for (let i = startIndex; i < fileList.length; i++) {
            currentIndex = i;
            setCurrentFileIndex(i);
            const file = fileList[i];
            setCurrentFileName(file.name);
            const baseBytes = prefixBytes[i] || 0;
            const denom = totalBytesAll || file.size || 1;
            setProgress(Math.min(100, (baseBytes / denom) * 100));
            try {
              await sendFileOverPeer(peer, file, baseBytes, i);
            } catch (e) {
              setRetryAttempt((a) => a + 1);
              setSystemMessage('Sistem: Koneksi bermasalah, sistem mencoba ulang...');
              try { peer.destroy(); } catch (x) {}
              if (peerRef.current === peer) peerRef.current = null;
              resolve({ retry: true, index: currentIndex });
              return;
            }
          }
          if (peerRef.current === peer) peerRef.current = null;
          resolve({ done: true });
        });

        const onFailure = () => {
          clearTimeout(connectTimeout);
          clearTimeout(connectMsgTimer);
          setRetryAttempt((a) => a + 1);
          setSystemMessage('Sistem: Koneksi terputus, sistem mencoba menyambungkan ulang...');
          try { peer.destroy(); } catch (x) {}
          if (peerRef.current === peer) peerRef.current = null;
          resolve({ retry: true, index: currentIndex });
        };

        peer.on('error', onFailure);
        peer.on('close', onFailure);
      });

      if (result?.done) break;
      startIndex = result?.index ?? startIndex;
      await sleep(Math.min(200, 20 + retryAttempt * 10));
    }

    setTimeout(() => {
      setSending(false);
      setSystemMessage('');
      setRetryAttempt(0);
      setTotalBytes(0);
      setFileList([]);
      setTargetUser(null);
    }, 500);
  };

  const acceptTransfer = (overrideSignal, autoAccept = false) => {
    if (!incomingSignal && !overrideSignal) return;
    if (!receiving) setReceiving(true);
    setProgress(0);
    const { from, signal } = overrideSignal || incomingSignal;
    setIncomingSignal(null);
    remotePeerIdRef.current = from;
    remoteCancelledRef.current = false;

    const peer = new Peer({
      initiator: false,
      trickle: true,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    peerRef.current = peer;
    peer.on('signal', (signal) => {
      socket.emit('signal', { to: from, from: me, signal });
    });

    peer.on('close', () => {
      if (receiving) {
        setRetryAttempt((a) => a + 1);
        setSystemMessage('Sistem: Koneksi terputus, menunggu pengirim mencoba lagi...');
      }
      setProgress(0);
      setTransferSpeed(0);
      if (peerRef.current === peer) peerRef.current = null;
    });
 
     peer.on('error', () => {
       if (receiving) {
         setRetryAttempt((a) => a + 1);
         setSystemMessage('Sistem: Terjadi gangguan jaringan, menunggu pengirim mencoba lagi...');
       }
       if (peerRef.current === peer) peerRef.current = null;
     });

    let receivedChunks = [];
    let metadata = null;
    let receivedSize = 0;
    let receivedCount = 0;
    let totalFilesLocal = 0;
    let totalBytesLocal = 0;
    let receivedBytesCompleted = 0;

    peer.on('connect', () => {
      setSystemMessage('');
      setTransferSpeed(0);
      speedRef.current = { bytes: 0, lastTime: Date.now() };
    });

    peer.on('data', (data) => {
      // Konversi data ke Buffer jika belum (karena kita sudah polyfill)
      const bufferData = Buffer.isBuffer(data) ? data : Buffer.from(data);
      updateSpeed(bufferData.length);

      // Cek apakah data adalah JSON (Metadata)
      if (bufferData[0] === 123) { // 123 adalah '{'
        try {
          const message = JSON.parse(bufferData.toString());
          if (message.type === 'batch-start') { 
            totalFilesLocal = message.count;
            setTotalFiles(message.count);
            totalBytesLocal = message.totalBytes || 0;
            setTotalBytes(totalBytesLocal);
            receivedBytesCompleted = 0;
            setCurrentFileIndex(0);
            return; 
          }
          if (message.type === 'progress') {
            lastSenderProgressAtRef.current = Date.now();
            if (!totalBytesLocal && message.totalBytes) {
              totalBytesLocal = message.totalBytes;
              setTotalBytes(totalBytesLocal);
            }
            if (typeof message.fileIndex === 'number') {
              setCurrentFileIndex(message.fileIndex);
            }
            if (message.fileName) {
              setCurrentFileName(message.fileName);
            }
            if (totalBytesLocal > 0) {
              setProgress(Math.min(100, (message.sentBytes / totalBytesLocal) * 100));
            }
            return;
          }
          if (message.type === 'metadata') {
            metadata = message;
            setCurrentFileName(message.name);
            receivedChunks = [];
            receivedSize = 0;
            if (totalBytesLocal > 0) {
              setProgress(Math.min(100, (receivedBytesCompleted / totalBytesLocal) * 100));
            } else {
              setProgress(0);
            }
            return;
          }
        } catch (e) {
          // Bukan JSON valid, abaikan dan anggap sebagai chunk binary
        }
      }

      // Penanganan File Chunk
      if (!metadata) return; // Abaikan jika metadata belum diterima

      receivedChunks.push(bufferData);
      receivedSize += bufferData.length;
      
      const senderProgressFresh = Date.now() - lastSenderProgressAtRef.current < 600;
      if (!senderProgressFresh) {
        if (totalBytesLocal > 0) {
          setProgress(Math.min(100, ((receivedBytesCompleted + receivedSize) / totalBytesLocal) * 100));
        } else {
          setProgress(Math.min(100, (receivedSize / metadata.size) * 100));
        }
      }
      
      if (receivedSize >= metadata.size) {
        const blob = new Blob(receivedChunks, { type: metadata.mime });
        const url = URL.createObjectURL(blob);
        const newFile = { name: metadata.name, url, size: metadata.size, time: new Date().toLocaleTimeString() };
        
        setReceivedFiles(prev => [...prev, newFile]);
        setHistory(prev => [newFile, ...prev].slice(0, 20));
        
        // Auto Download
        const link = document.createElement('a');
        link.href = url;
        link.download = metadata.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        metadata = null; // Reset metadata untuk file berikutnya
        receivedBytesCompleted += (newFile.size || 0);
        if (totalBytesLocal > 0) {
          setProgress(Math.min(100, (receivedBytesCompleted / totalBytesLocal) * 100));
        }
        receivedCount++;
        setCurrentFileIndex(receivedCount);
        
        if (receivedCount >= totalFilesLocal) {
          setTimeout(() => {
            setReceiving(false);
            setTotalBytes(0);
          }, 1000);
        }
      }
    });
    peer.signal(signal);
  };

  const handleSaveName = (newName) => {
    if (!newName.trim()) return;
    setUserName(newName);
    localStorage.setItem('userName', newName);
    setIsEditingName(false);
  };

  const handleDeleteHistory = () => {
    if (deleteConfirm === null) return;
    const newHistory = history.filter((_, i) => i !== deleteConfirm.index);
    setHistory(newHistory);
    setDeleteConfirm(null);
    
    // Sesuaikan pagination jika halaman jadi kosong
    const totalPages = Math.ceil(newHistory.length / itemsPerPage);
    if (historyPage > totalPages && totalPages > 0) {
      setHistoryPage(totalPages);
    }
  };

  const handleDeleteAllHistory = () => {
    setHistory([]);
    setHistoryPage(1);
    setDeleteAllConfirm(false);
  };

  const cancelTransfer = () => {
      const to = remotePeerIdRef.current || targetUser?.id || incomingSignal?.from;
      if (to) {
        socket.emit('signal', { to, from: me, signal: { type: 'cancel' } });
      }
     
     if (peerRef.current) {
       peerRef.current.destroy();
       peerRef.current = null;
     }
     
     // Beri sedikit waktu untuk socket terkirim sebelum refresh
     setTimeout(() => {
       window.location.reload();
     }, 100);
   };

  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); };
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) setFileList(prev => [...prev, ...droppedFiles]);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="flex items-center justify-between mb-12">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 flex items-center justify-center overflow-hidden">
              <img src="/logo.png" alt="KirimFile Logo" className="w-full h-full object-contain transform scale-110" />
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <div className="flex items-center gap-2 group">
                <h1 className="text-xl md:text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400 break-words line-clamp-2 md:line-clamp-1">
                  {userName || 'Set Nama'}
                </h1>
                <button onClick={() => { setTempName(userName); setIsEditingName(true); }} className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-500 hover:text-blue-400 transition-all shrink-0">
                  <Edit2 size={14} />
                </button>
              </div>
              <p className="text-slate-400 text-xs md:text-sm flex items-center gap-1 shrink-0"><ShieldCheck size={14} className="text-blue-500" /> KirimFile Secure P2P</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className={`px-4 py-1.5 rounded-full border text-xs font-bold tracking-wide transition-all ${isConnected ? 'bg-green-500/10 border-green-500/50 text-green-400' : 'bg-red-500/10 border-red-500/50 text-red-400'}`}>
              <span className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="hidden md:inline">{isConnected ? 'ONLINE' : 'OFFLINE'}</span>
              </span>
            </div>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Perangkat Terdekat */}
          <section className="lg:col-span-4 space-y-6 order-1 lg:order-1">
            <h2 className="text-lg font-semibold text-slate-300 flex items-center gap-2"><Monitor size={20} /> Perangkat Terdekat</h2>
            <div className="space-y-3">
              {users.length === 0 ? (
                <div className="p-8 text-center bg-slate-800/50 rounded-2xl border border-dashed border-slate-700">
                  <div className="animate-pulse flex flex-col items-center"><Loader2 className="animate-spin mb-3 text-slate-500" /><p className="text-slate-500">Mencari perangkat lain...</p></div>
                </div>
              ) : (
                users.map((user) => (
                  <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} key={user.id} onClick={() => setTargetUser(user)} className={`p-5 rounded-2xl border cursor-pointer transition-all flex items-center justify-between ${targetUser?.id === user.id ? 'bg-blue-600/20 border-blue-500 shadow-xl shadow-blue-500/10' : 'bg-slate-800 border-slate-700 hover:border-slate-600'}`}>
                    <div className="flex items-center gap-4">
                      <div className={`p-3 rounded-xl ${targetUser?.id === user.id ? 'bg-blue-600' : 'bg-slate-700'}`}>{user.deviceType === 'Mobile' ? <Smartphone size={24} /> : <Monitor size={24} />}</div>
                      <div className="overflow-hidden"><h3 className="font-bold text-slate-100 truncate">{user.name}</h3><p className="text-[11px] text-slate-400 font-medium">{user.deviceType}</p></div>
                    </div>
                  </motion.div>
                ))
              )}
            </div>
          </section>

          {/* Area Transfer */}
          <section className="lg:col-span-8 space-y-6 order-2 lg:order-2">
            <h2 className="text-lg font-semibold text-slate-300 flex items-center gap-2"><Files size={20} /> Transfer File</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div onDragOver={handleDragOver} onDrop={handleDrop} onClick={() => fileInputRef.current.click()} className="h-64 border-2 border-dashed border-slate-700 bg-slate-800/30 rounded-3xl flex flex-col items-center justify-center cursor-pointer hover:border-blue-500/50 hover:bg-slate-800/50 transition-all group">
                <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileSelect} multiple />
                <div className="w-16 h-16 bg-blue-600/10 rounded-2xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform"><FileUp size={32} className="text-blue-500" /></div>
                <p className="font-medium text-lg mb-1">
                  <span className="hidden md:inline">Drag & Drop Atau </span>Pilih File
                </p>
                <p className="text-sm text-slate-400 text-center px-4">Masukkan File Anda Tanpa Batas</p>
              </div>

              <div className="bg-slate-800/50 rounded-3xl p-6 border border-slate-700 flex flex-col justify-between">
                <div>
                  <h3 className="font-semibold text-slate-400 mb-4">Ringkasan</h3>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm"><span>Jumlah File:</span><span className="font-bold">{fileList.length}</span></div>
                    <div className="flex justify-between text-sm"><span>Total Ukuran:</span><span className="font-bold">{formatSize(fileList.reduce((acc, f) => acc + f.size, 0))}</span></div>
                    <div className="flex justify-between text-sm"><span>Penerima:</span><span className="font-bold text-blue-400">{targetUser ? targetUser.name : 'Belum Dipilih'}</span></div>
                  </div>
                </div>
                <button disabled={fileList.length === 0 || !targetUser || sending || receiving} onClick={startTransfer} className={`w-full py-4 mt-6 rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-2 ${fileList.length === 0 || !targetUser || sending || receiving ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-xl shadow-blue-600/20 active:scale-[0.98]'}`}>
                  {sending ? <Loader2 className="animate-spin" /> : null}{sending ? `Mengirim... ${currentFileIndex + 1}/${fileList.length}` : 'Mulai Kirim'}
                </button>
              </div>
            </div>

            {fileList.length > 0 && (
              <div className="bg-slate-800 rounded-3xl border border-slate-700 overflow-hidden">
                <div className="p-4 border-b border-slate-700 bg-slate-800/50 flex justify-between items-center"><h3 className="font-bold">Daftar File</h3><button onClick={() => setFileList([])} className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"><Trash2 size={14} /> Hapus Semua</button></div>
                <div className="max-h-64 overflow-y-auto"><table className="w-full text-left text-sm"><tbody className="divide-y divide-slate-700">{fileList.map((f, i) => (<tr key={i} className="hover:bg-slate-700/30"><td className="px-6 py-4 flex items-center gap-3 truncate max-w-[200px]"><FileIcon size={16} className="text-blue-400 shrink-0" />{f.name}</td><td className="px-6 py-4 text-slate-400">{formatSize(f.size)}</td><td className="px-6 py-4 text-right"><button onClick={() => removeFile(i)} className="p-2 hover:bg-red-500/10 text-slate-500 hover:text-red-400 rounded-lg"><X size={16} /></button></td></tr>))}</tbody></table></div>
              </div>
            )}
          </section>

          {/* Riwayat Transfer */}
          <section className="lg:col-span-12 space-y-6 order-3">
            {history.length > 0 && (
              <div className="mt-8">
                <div className="flex items-center justify-between gap-4 mb-4">
                  <h2 className="text-lg font-semibold text-slate-300 flex items-center gap-2"><History size={20} /> Riwayat Terakhir</h2>
                  <button onClick={() => setDeleteAllConfirm(true)} className="md:hidden p-2.5 hover:bg-red-500/20 text-red-300 border border-red-500/20 rounded-xl transition-all">
                    <Trash2 size={18} />
                  </button>
                  <button onClick={() => setDeleteAllConfirm(true)} className="hidden md:inline-flex items-center gap-2 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 rounded-xl font-bold transition-all">
                    <Trash2 size={16} />
                    Hapus Semua
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {history.slice((historyPage - 1) * itemsPerPage, historyPage * itemsPerPage).map((h, i) => {
                     const actualIndex = (historyPage - 1) * itemsPerPage + i;
                     return (
                       <div key={actualIndex} className="bg-slate-800/40 p-4 rounded-2xl border border-slate-700/50 flex items-center justify-between gap-3 hover:bg-slate-800/60 transition-colors group">
                         <div className="flex items-center gap-3 overflow-hidden">
                           <div className="p-3 bg-slate-700/50 rounded-xl shrink-0 group-hover:bg-blue-600/10 transition-colors"><FileIcon size={18} className="text-blue-400" /></div>
                           <div className="overflow-hidden"><p className="text-sm font-bold truncate text-slate-200">{h.name}</p><p className="text-[11px] text-slate-500 flex items-center gap-1 mt-0.5"><Clock size={12} /> {h.time} • {formatSize(h.size)}</p></div>
                         </div>
                         <div className="flex items-center gap-1">
                           <a href={h.url} download={h.name} className="p-2.5 hover:bg-blue-600 text-blue-400 hover:text-white rounded-xl transition-all" title="Download"><Download size={18} /></a>
                           <button 
                             onClick={() => setDeleteConfirm({ index: actualIndex, name: h.name })}
                             className="p-2.5 hover:bg-red-500/20 text-slate-500 hover:text-red-400 rounded-xl transition-all"
                             title="Hapus"
                           >
                             <Trash2 size={18} />
                           </button>
                         </div>
                       </div>
                     );
                   })}
                </div>
                
                {/* Pagination */}
                {history.length > itemsPerPage && (
                  <div className="flex items-center justify-center gap-4 mt-8">
                    <button disabled={historyPage === 1} onClick={() => setHistoryPage(p => p - 1)} className="px-6 py-2 bg-slate-800 border border-slate-700 rounded-xl disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors font-bold text-sm">Sebelumnya</button>
                    <span className="text-slate-400 font-bold text-sm">Halaman {historyPage} dari {Math.ceil(history.length / itemsPerPage)}</span>
                    <button disabled={historyPage === Math.ceil(history.length / itemsPerPage)} onClick={() => setHistoryPage(p => p + 1)} className="px-6 py-2 bg-slate-800 border border-slate-700 rounded-xl disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors font-bold text-sm">Berikutnya</button>
                  </div>
                )}
              </div>
            )}
          </section>
        </main>

        {/* Overlay Progress (Sending & Receiving) */}
        <AnimatePresence>
          {(sending || receiving) && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
              <div className="bg-slate-800 border border-slate-700 p-8 rounded-3xl w-full max-w-md shadow-2xl">
                <div className="text-center mb-6">
                  <div className="w-20 h-20 bg-blue-600/20 rounded-3xl flex items-center justify-center mx-auto mb-4">
                    <Loader2 size={40} className="text-blue-500 animate-spin" />
                  </div>
                  <h3 className="text-xl font-bold mb-2">
                    {sending ? `Mengirim (${currentFileIndex + 1}/${totalFiles})` : `Menerima (${Math.min(currentFileIndex + 1, totalFiles)}/${totalFiles})`}
                  </h3>
                  <p className="text-slate-400 text-sm truncate px-4">{currentFileName || 'Sedang memproses...'}</p>
                </div>
                <div className="w-full bg-slate-700 h-3 rounded-full overflow-hidden mb-2">
                  <motion.div initial={{ width: 0 }} animate={{ width: `${progress}%` }} className="h-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
                </div>
                <div className="flex justify-between text-sm font-medium">
                  <span className="text-blue-400">{Math.round(progress)}%</span>
                  <span className="text-slate-500">100%</span>
                </div>
                {/* Kecepatan Transfer & Tombol Cancel */}
                <div className="mt-6 flex flex-col items-center gap-4">
                  <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-slate-900/50 rounded-full border border-slate-700/50">
                    <Wifi size={14} className="text-blue-400" />
                    <span className="text-sm font-mono font-bold text-blue-100">
                      {formatSize(transferSpeed)}/s
                    </span>
                  </div>
                  {systemMessage ? (
                    <p className="text-xs text-slate-300 text-center max-w-xs">
                      {systemMessage}
                    </p>
                  ) : null}
                  
                  <button 
                    onClick={cancelTransfer}
                    className="flex items-center gap-2 px-6 py-3 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-2xl font-bold transition-all active:scale-95 group"
                  >
                    <X size={18} className="group-hover:rotate-90 transition-transform duration-300" />
                    Batalkan Pengiriman
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {/* Notifikasi Terima File */}
          {incomingSignal && (
            <motion.div initial={{ opacity: 0, y: 50, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="fixed inset-0 md:inset-auto md:bottom-8 md:right-8 flex items-center justify-center md:items-end md:justify-end z-[70] p-4 pointer-events-none">
              <div className="bg-slate-800 border-2 border-blue-500/50 p-8 rounded-[2.5rem] shadow-[0_0_50px_rgba(30,58,138,0.5)] w-full max-w-sm pointer-events-auto">
                <div className="flex flex-col items-center text-center gap-6 mb-8">
                  <div className="p-5 bg-blue-600 rounded-3xl shadow-lg shadow-blue-600/20"><Files size={40} className="text-white" /></div>
                  <div>
                    <h3 className="text-2xl font-black text-white mb-2">File Masuk!</h3>
                    <p className="text-slate-400 font-medium">
                      <span className="text-blue-400 font-bold">{users.find(u => u.id === incomingSignal.from)?.name || 'Perangkat Lain'}</span> ingin mengirimkan file ke Anda.
                    </p>
                  </div>
                </div>
                <div className="flex flex-col gap-3">
                  <button onClick={acceptTransfer} className="w-full bg-blue-600 hover:bg-blue-500 py-4 rounded-2xl font-bold text-lg shadow-xl shadow-blue-600/20 active:scale-95 transition-all">Terima Sekarang</button>
                  <button onClick={() => setIncomingSignal(null)} className="w-full bg-slate-700/50 hover:bg-slate-700 py-4 rounded-2xl font-bold text-slate-300 active:scale-95 transition-all">Tolak</button>
                </div>
              </div>
            </motion.div>
          )}

          {/* Nama Edit Dialog */}
          {isEditingName && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
              <div className="bg-slate-800 border border-slate-700 p-8 rounded-3xl w-full max-w-sm shadow-2xl">
                <div className="text-center mb-6">
                  <div className="w-16 h-16 bg-blue-600/20 rounded-2xl flex items-center justify-center mx-auto mb-4"><User className="text-blue-500" size={32} /></div>
                  <h3 className="text-xl font-bold">Nama Perangkat</h3>
                  <p className="text-slate-400 text-sm mt-2">Nama ini akan terlihat oleh orang lain</p>
                </div>
                <input autoFocus type="text" value={tempName} onChange={(e) => setTempName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSaveName(tempName); if (e.key === 'Escape') setIsEditingName(false); }} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-500 mb-6" />
                <div className="flex gap-3">
                  <button onClick={() => setIsEditingName(false)} className="flex-1 px-4 py-3 bg-slate-700 hover:bg-slate-600 rounded-xl font-bold">Batal</button>
                  <button onClick={() => handleSaveName(tempName)} className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl font-bold">Simpan</button>
                </div>
              </div>
            </motion.div>
          )}

          {/* Dialog Konfirmasi Hapus Riwayat */}
          {deleteConfirm && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-[80] p-4">
              <div className="bg-slate-800 border border-slate-700 p-8 rounded-3xl w-full max-w-sm shadow-2xl">
                <div className="text-center mb-6">
                  <div className="w-16 h-16 bg-red-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="text-red-500" size={32} /></div>
                  <h3 className="text-xl font-bold">Hapus Riwayat?</h3>
                  <p className="text-slate-400 text-sm mt-2">Apakah Anda yakin ingin menghapus <span className="text-white font-bold">{deleteConfirm.name}</span> dari riwayat?</p>
                </div>
                <div className="flex gap-3">
                  <button ref={cancelBtnRef} onClick={() => setDeleteConfirm(null)} className="flex-1 px-4 py-3 bg-slate-700 hover:bg-slate-600 rounded-xl font-bold">Batal</button>
                  <button ref={confirmBtnRef} onClick={handleDeleteHistory} className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-500 rounded-xl font-bold text-white">Hapus</button>
                </div>
              </div>
            </motion.div>
          )}

          {deleteAllConfirm && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-[80] p-4">
              <div className="bg-slate-800 border border-slate-700 p-8 rounded-3xl w-full max-w-sm shadow-2xl">
                <div className="text-center mb-6">
                  <div className="w-16 h-16 bg-red-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="text-red-500" size={32} /></div>
                  <h3 className="text-xl font-bold">Hapus Semua Riwayat?</h3>
                  <p className="text-slate-400 text-sm mt-2">Semua data riwayat transfer akan dihapus permanen dari perangkat ini.</p>
                </div>
                <div className="flex gap-3">
                  <button ref={cancelBtnRef} onClick={() => setDeleteAllConfirm(false)} className="flex-1 px-4 py-3 bg-slate-700 hover:bg-slate-600 rounded-xl font-bold">Batal</button>
                  <button ref={confirmBtnRef} onClick={handleDeleteAllHistory} className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-500 rounded-xl font-bold text-white">Hapus</button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default App;
