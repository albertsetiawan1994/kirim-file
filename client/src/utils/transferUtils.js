/**
 * transferUtils.js - Advanced P2P Utilities
 * Fokus: Keamanan (Web Crypto API), Optimasi Performance, dan Robustness.
 */

import pako from 'pako';

export const PEER_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  iceTransportPolicy: 'all'
};

/**
 * Menganalisis ICE Candidate untuk menentukan apakah koneksi lokal atau internet
 */
export const detectConnectionType = (candidate) => {
  if (!candidate) return 'Unknown';
  
  const parts = candidate.split(' ');
  const type = parts[7]; 
  
  switch (type) {
    case 'host':
      return 'Lokal';
    case 'srflx':
      return 'Internet (STUN)';
    case 'relay':
      return 'Internet (TURN)';
    default:
      return 'Internet';
  }
};

/**
 * Estimasi sisa waktu transfer (ETA)
 * Mengembalikan objek dengan label teks dan nilai detik murni
 */
export const calculateETA = (totalSize, uploadedSize, speed) => {
  if (speed <= 0) return { text: '--:--', seconds: 0 };
  const remaining = totalSize - uploadedSize;
  const totalSeconds = Math.floor(remaining / speed);
  
  let text = '';
  if (totalSeconds < 0) text = '0s';
  else if (totalSeconds < 60) text = `${totalSeconds}s`;
  else if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    text = `${minutes}m ${remainingSeconds}s`;
  } else {
    const hours = Math.floor(totalSeconds / 3600);
    const remainingMinutes = Math.floor((totalSeconds % 3600) / 60);
    text = `${hours}h ${remainingMinutes}m`;
  }

  return { text, seconds: totalSeconds };
};

/**
 * Kompresi data jika ukuran > 1MB
 */
export const compressData = (data) => {
  if (data.byteLength < 1024 * 1024) return { compressed: false, data };
  try {
    const compressed = pako.deflate(new Uint8Array(data));
    return { compressed: true, data: compressed.buffer };
  } catch (e) {
    return { compressed: false, data };
  }
};

export const decompressData = (data) => {
  try {
    return pako.inflate(new Uint8Array(data)).buffer;
  } catch (e) {
    return data;
  }
};

// Ukuran chunk dioptimalkan untuk throughput tinggi (64KB - 256KB)
export const MIN_CHUNK_SIZE = 65536; 
export const MAX_CHUNK_SIZE = 262144;
export const BUFFER_THRESHOLD = 4 * 1024 * 1024; // 4MB buffer limit for high-speed streaming

/**
 * Format ukuran file dengan presisi tinggi
 */
export const formatSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

/**
 * Kecepatan transfer human-readable
 */
export const formatSpeed = (bytesPerSecond) => {
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
};

/**
 * Deteksi informasi perangkat modern
 */
export const getDeviceInfo = () => {
  const ua = navigator.userAgent;
  const platform = navigator.platform;
  
  let deviceName = 'Generic Device';
  if (/Win/i.test(platform)) deviceName = 'Windows PC';
  else if (/Mac/i.test(platform)) deviceName = 'Apple Mac';
  else if (/Linux/i.test(platform)) deviceName = 'Linux Station';
  else if (/Android/i.test(ua)) deviceName = 'Android Device';
  else if (/iPhone|iPad|iPod/i.test(ua)) deviceName = 'iOS Device';

  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  
  return {
    deviceName,
    osName: isMobile ? 'Mobile' : 'Desktop',
    isMobile,
    browser: /Chrome/i.test(ua) ? 'Chrome' : /Firefox/i.test(ua) ? 'Firefox' : 'Other',
    localIPs: [] // Will be populated by WebRTC if possible
  };
};

/**
 * Cek apakah sebuah IP adalah private/local network
 */
export const isLocalIP = (ip) => {
  return /^(127\.0\.0\.1|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(ip);
};

/**
 * Keamanan: Enkripsi End-to-End menggunakan AES-GCM (Native Web Crypto)
 */
export const generateKey = async (password, salt) => {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
};

export const encryptChunk = async (key, data, iv) => {
  return window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
};

export const decryptChunk = async (key, data, iv) => {
  return window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
};

/**
 * Validasi Integritas: SHA-256 Checksum
 */
export const calculateHash = async (file) => {
  const arrayBuffer = await file.arrayBuffer();
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Helper untuk Signaling
 */
export const emitSignal = (socket, to, from, signal, metadata = {}) => {
  if (socket) {
    socket.emit('signal', { to, from, signal, ...metadata });
  }
};

/**
 * Parser pesan data channel dengan proteksi type-safety
 */
export const parseMessage = (data) => {
  try {
    const str = data instanceof Uint8Array ? new TextDecoder().decode(data) : data.toString();
    if (str.startsWith('{') && str.endsWith('}')) {
      const message = JSON.parse(str);
      return { type: 'json', message };
    }
  } catch (e) {
    // Not JSON or parse error
  }
  return { type: 'binary', data };
};
