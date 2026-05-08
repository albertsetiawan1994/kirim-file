import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer';
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
  ShieldCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// PENTING: Untuk auto-discovery tanpa IP manual, kita butuh signaling server global yang support HTTPS.
// Ganti URL ini dengan URL backend Anda setelah di-deploy ke Render/Heroku (misal: https://kirim-file-signaling.onrender.com)
const GLOBAL_SIGNALING_URL = 'https://kirim-file-signaling.onrender.com'; 

function App() {
  const [socket, setSocket] = useState(null);
  const [me, setMe] = useState('');
  const [users, setUsers] = useState([]);
  const [targetUser, setTargetUser] = useState(null);
  const [fileList, setFileList] = useState([]);
  const [sending, setSending] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [receivedFiles, setReceivedFiles] = useState([]);
  const [incomingSignal, setIncomingSignal] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  
  const peerRef = useRef();
  const fileInputRef = useRef();

  useEffect(() => {
    // Menghubungkan ke signaling server otomatis
    const newSocket = io(GLOBAL_SIGNALING_URL, {
      transports: ['websocket'],
      secure: true
    });

    newSocket.on('connect', () => {
      setMe(newSocket.id);
      setIsConnected(true);
      
      // Mengirim data perangkat ke server
      newSocket.emit('join', {
        name: `${osName()} ${deviceName()}`,
        deviceType: isMobile() ? 'mobile' : 'desktop'
      });
    });

    newSocket.on('users-list', (usersList) => {
      // Filter agar hanya menampilkan orang lain
      setUsers(usersList.filter(u => u.id !== newSocket.id));
    });

    newSocket.on('signal', ({ from, signal }) => {
      if (signal.type === 'offer') {
        setIncomingSignal({ from, signal });
      } else if (peerRef.current) {
        peerRef.current.signal(signal);
      }
    });

    newSocket.on('disconnect', () => setIsConnected(false));

    setSocket(newSocket);
    return () => newSocket.close();
  }, []);

  const deviceName = () => {
    const userAgent = navigator.userAgent;
    if (userAgent.includes('Windows')) return 'Windows PC';
    if (userAgent.includes('Mac')) return 'MacBook';
    if (userAgent.includes('Android')) return 'Android Device';
    if (userAgent.includes('iPhone')) return 'iPhone';
    return 'Unknown Device';
  };

  const osName = () => isMobile() ? 'Mobile' : 'Desktop';
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

  const startTransfer = async () => {
    if (fileList.length === 0 || !targetUser) return;
    setSending(true);
    
    const peer = new Peer({
      initiator: true,
      trickle: false,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } // Membantu koneksi antar jaringan
    });

    peerRef.current = peer;

    peer.on('signal', (signal) => {
      socket.emit('signal', { to: targetUser.id, from: me, signal });
    });

    peer.on('connect', async () => {
      peer.send(JSON.stringify({ type: 'batch-start', count: fileList.length }));

      for (let i = 0; i < fileList.length; i++) {
        setCurrentFileIndex(i);
        const file = fileList[i];
        setProgress(0);

        await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            const buffer = e.target.result;
            const chunkSize = 16384 * 2;
            let offset = 0;

            peer.send(JSON.stringify({
              type: 'metadata',
              name: file.name,
              size: file.size,
              mime: file.type || 'application/octet-stream'
            }));

            const sendChunk = () => {
              while (offset < buffer.byteLength) {
                const chunk = buffer.slice(offset, offset + chunkSize);
                peer.send(chunk);
                offset += chunkSize;
                setProgress(Math.min(100, (offset / buffer.byteLength) * 100));
                if (offset % (chunkSize * 50) === 0) {
                  setTimeout(sendChunk, 0);
                  return;
                }
              }
              resolve();
            };
            sendChunk();
          };
          reader.readAsArrayBuffer(file);
        });
      }
      setSending(false);
      setFileList([]);
      setTargetUser(null);
    });
  };

  const acceptTransfer = () => {
    setReceiving(true);
    setProgress(0);
    const { from, signal } = incomingSignal;
    setIncomingSignal(null);

    const peer = new Peer({
      initiator: false,
      trickle: false,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    peerRef.current = peer;
    peer.on('signal', (signal) => {
      socket.emit('signal', { to: from, from: me, signal });
    });

    let receivedChunks = [];
    let metadata = null;
    let receivedSize = 0;
    let totalFiles = 0;
    let currentFilesCount = 0;

    peer.on('data', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'batch-start') { totalFiles = message.count; return; }
        if (message.type === 'metadata') {
          metadata = message;
          receivedChunks = [];
          receivedSize = 0;
          setProgress(0);
          return;
        }
      } catch (e) {}

      receivedChunks.push(data);
      receivedSize += data.length;
      
      if (metadata) {
        setProgress(Math.min(100, (receivedSize / metadata.size) * 100));
        if (receivedSize >= metadata.size) {
          const blob = new Blob(receivedChunks, { type: metadata.mime });
          const url = URL.createObjectURL(blob);
          setReceivedFiles(prev => [...prev, { name: metadata.name, url, size: metadata.size }]);
          currentFilesCount++;
          if (currentFilesCount >= totalFiles) setReceiving(false);
        }
      }
    });
    peer.signal(signal);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="flex items-center justify-between mb-12">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-blue-600 rounded-2xl overflow-hidden shadow-lg shadow-blue-500/20">
              <img src="/logo.png" alt="KirimFile Logo" className="w-full h-full object-cover" />
            </div>
            <div>
              <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400">
                KirimFile
              </h1>
              <p className="text-slate-400 text-sm flex items-center gap-1">
                <ShieldCheck size={14} className="text-blue-500" /> 
                Secure P2P Transfer
              </p>
            </div>
          </div>
          <div className={`px-4 py-2 rounded-full border text-sm font-medium ${isConnected ? 'bg-green-500/10 border-green-500/50 text-green-400' : 'bg-red-500/10 border-red-500/50 text-red-400'}`}>
            {isConnected ? `Online: ${me.slice(0, 6)}` : 'Connecting...'}
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Device List */}
          <section className="lg:col-span-4 space-y-6">
            <h2 className="text-lg font-semibold text-slate-300 flex items-center gap-2">
              <Monitor size={20} /> Perangkat Terdekat
            </h2>
            <div className="space-y-3">
              {users.length === 0 ? (
                <div className="p-8 text-center bg-slate-800/50 rounded-2xl border border-dashed border-slate-700">
                  <div className="animate-pulse flex flex-col items-center">
                    <Loader2 className="animate-spin mb-3 text-slate-500" />
                    <p className="text-slate-500">Mencari perangkat lain...</p>
                  </div>
                </div>
              ) : (
                users.map((user) => (
                  <motion.div
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    key={user.id}
                    onClick={() => setTargetUser(user)}
                    className={`p-4 rounded-2xl border cursor-pointer transition-all flex items-center justify-between ${
                      targetUser?.id === user.id 
                        ? 'bg-blue-600/10 border-blue-500 shadow-lg shadow-blue-500/10' 
                        : 'bg-slate-800 border-slate-700 hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <div className={`p-3 rounded-xl ${targetUser?.id === user.id ? 'bg-blue-600' : 'bg-slate-700'}`}>
                        {user.deviceType === 'mobile' ? <Smartphone size={24} /> : <Monitor size={24} />}
                      </div>
                      <div>
                        <h3 className="font-medium">{user.name}</h3>
                        <p className="text-xs text-slate-400 capitalize">{user.deviceType}</p>
                      </div>
                    </div>
                  </motion.div>
                ))
              )}
            </div>
          </section>

          {/* Transfer Area */}
          <section className="lg:col-span-8 space-y-6">
            <h2 className="text-lg font-semibold text-slate-300 flex items-center gap-2">
              <Files size={20} /> Transfer File
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div 
                onClick={() => fileInputRef.current.click()}
                className="h-64 border-2 border-dashed border-slate-700 bg-slate-800/30 rounded-3xl flex flex-col items-center justify-center cursor-pointer hover:border-blue-500/50 hover:bg-slate-800/50 transition-all group"
              >
                <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileSelect} multiple />
                <div className="w-16 h-16 bg-blue-600/10 rounded-2xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                  <FileUp size={32} className="text-blue-500" />
                </div>
                <p className="font-medium text-lg mb-1">Pilih File / Folder</p>
                <p className="text-sm text-slate-400 text-center px-4">Otomatis muncul di perangkat yang membuka link ini</p>
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
                <button
                  disabled={fileList.length === 0 || !targetUser || sending || receiving}
                  onClick={startTransfer}
                  className={`w-full py-4 mt-6 rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-2 ${
                    fileList.length === 0 || !targetUser || sending || receiving
                      ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                      : 'bg-blue-600 hover:bg-blue-500 text-white shadow-xl shadow-blue-600/20 active:scale-[0.98]'
                  }`}
                >
                  {sending ? <Loader2 className="animate-spin" /> : <Share2 size={20} />}
                  {sending ? `Mengirim... ${currentFileIndex + 1}/${fileList.length}` : 'Mulai Kirim'}
                </button>
              </div>
            </div>

            {/* File Table */}
            {fileList.length > 0 && (
              <div className="bg-slate-800 rounded-3xl border border-slate-700 overflow-hidden">
                <div className="p-4 border-b border-slate-700 bg-slate-800/50 flex justify-between items-center">
                  <h3 className="font-bold">Daftar File</h3>
                  <button onClick={() => setFileList([])} className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"><Trash2 size={14} /> Hapus Semua</button>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-left text-sm">
                    <tbody className="divide-y divide-slate-700">
                      {fileList.map((f, i) => (
                        <tr key={i} className="hover:bg-slate-700/30">
                          <td className="px-6 py-4 flex items-center gap-3 truncate max-w-[200px]"><FileIcon size={16} className="text-blue-400 shrink-0" />{f.name}</td>
                          <td className="px-6 py-4 text-slate-400">{formatSize(f.size)}</td>
                          <td className="px-6 py-4 text-right"><button onClick={() => removeFile(i)} className="p-2 hover:bg-red-500/10 text-slate-500 hover:text-red-400 rounded-lg"><X size={16} /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </main>

        <AnimatePresence>
          {(sending || receiving) && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
              <div className="bg-slate-800 border border-slate-700 p-8 rounded-3xl w-full max-w-md shadow-2xl">
                <div className="text-center mb-6">
                  <div className="w-20 h-20 bg-blue-600/20 rounded-3xl flex items-center justify-center mx-auto mb-4">
                    <Loader2 size={40} className="text-blue-500 animate-spin" />
                  </div>
                  <h3 className="text-xl font-bold mb-2">{sending ? `Mengirim (${currentFileIndex + 1}/${fileList.length})` : 'Menerima File...'}</h3>
                  <p className="text-slate-400 text-sm truncate px-4">{sending ? fileList[currentFileIndex]?.name : 'Sedang memproses...'}</p>
                </div>
                <div className="w-full bg-slate-700 h-3 rounded-full overflow-hidden mb-2">
                  <motion.div initial={{ width: 0 }} animate={{ width: `${progress}%` }} className="h-full bg-blue-500" />
                </div>
                <div className="flex justify-between text-sm font-medium">
                  <span className="text-blue-400">{Math.round(progress)}%</span>
                  <span className="text-slate-500">100%</span>
                </div>
              </div>
            </motion.div>
          )}
          {incomingSignal && (
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="fixed bottom-8 right-8 z-50">
              <div className="bg-slate-800 border border-blue-500/30 p-6 rounded-3xl shadow-2xl w-80">
                <div className="flex items-start gap-4 mb-4">
                  <div className="p-3 bg-blue-600 rounded-xl"><Files size={24} /></div>
                  <div>
                    <h3 className="font-bold">File Masuk</h3>
                    <p className="text-sm text-slate-400">Dari {users.find(u => u.id === incomingSignal.from)?.name || 'Perangkat Lain'}</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={acceptTransfer} className="flex-1 bg-blue-600 hover:bg-blue-500 py-2 rounded-xl font-semibold">Terima</button>
                  <button onClick={() => setIncomingSignal(null)} className="px-4 bg-slate-700 hover:bg-slate-600 py-2 rounded-xl font-semibold">Tolak</button>
                </div>
              </div>
            </motion.div>
          )}
          {receivedFiles.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 w-full max-w-2xl">
              <div className="bg-slate-800 border-2 border-green-500/50 p-4 rounded-3xl shadow-2xl mx-4">
                <div className="flex items-center justify-between mb-4 px-2">
                  <div className="flex items-center gap-2"><CheckCircle className="text-green-500" size={20} /><span className="font-bold">Berhasil Menerima {receivedFiles.length} File</span></div>
                  <button onClick={() => setReceivedFiles([])} className="text-slate-400 hover:text-white"><X size={20} /></button>
                </div>
                <div className="max-h-48 overflow-y-auto space-y-2">
                  {receivedFiles.map((rf, i) => (
                    <div key={i} className="bg-slate-900/50 p-3 rounded-2xl flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 overflow-hidden">
                        <FileIcon size={18} className="text-blue-400 shrink-0" />
                        <div className="overflow-hidden"><p className="font-bold text-xs truncate">{rf.name}</p><p className="text-[10px] text-slate-500">{formatSize(rf.size)}</p></div>
                      </div>
                      <a href={rf.url} download={rf.name} className="bg-green-600 hover:bg-green-500 text-white px-4 py-1.5 rounded-xl text-xs font-bold shrink-0">Download</a>
                    </div>
                  ))}
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
