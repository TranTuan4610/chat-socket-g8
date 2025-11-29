const API_BASE = "https://chat-socket-g8.onrender.com";
const socket = io(API_BASE, {
  transports: ["websocket", "polling"]
});

// --- 1. KIỂM TRA ĐĂNG NHẬP ---
const storedName = localStorage.getItem('chat_username');

if (!storedName) {
  window.location.href = 'login.html';
} else {
  boot(storedName);
}

// --- 2. KHAI BÁO BIẾN ---
let username = '';
let currentRoom = 'general';
let dmTarget = '';
let typingTimeout = null;

// WebRTC / Call
let pc = null;
let localStream = null;
let currentCallPeer = null;
let currentCallIsVideo = false;
let remoteAudioEl = null;

// trạng thái cuộc gọi: 'idle' | 'outgoing' | 'ringing' | 'in-call'
let currentCallStatus = 'idle';
let incomingOffer = null;
let callTimeoutId = null;

// Group Call (call cả phòng) - mesh
let groupCallActive = false;
let groupCallRoom = null;
let groupLocalStream = null;
let groupPeers = {};          // username -> RTCPeerConnection
let groupRemoteStreams = {};  // username -> MediaStream

// DOM helper
const $ = (q) => document.querySelector(q);

const messages = $('#messages');
const input = $('#input');
const form = $('#form');
const roomsBox = $('#rooms');
const usersBox = $('#usersOnline');
const me = $('#me');
const target = $('#target');
const typingStatus = $('#typingStatus');
const fileInput = $('#fileInput');
const fileUploadBtn = $('#fileUploadBtn');
const btnLogout = $('#btnLogout');

// Profile DOM
const userProfileBox = document.getElementById('userProfileBox');
const profileBox = document.getElementById('profileDetails');
const profileNameValue = document.getElementById('profileNameValue');
const profileEmailValue = document.getElementById('profileEmailValue');
const profileTypeValue = document.getElementById('profileTypeValue');

// Toggle hiển thị hộp profile khi click vào khối user (trừ nút logout)
if (userProfileBox && profileBox) {
  userProfileBox.addEventListener('click', (e) => {
    // không toggle khi bấm vào nút logout
    if (e.target.closest('#btnLogout')) return;
    profileBox.classList.toggle('open');
  });
}


// Call DOM
const btnCallVoice = document.getElementById('btnCallVoice');
const btnCallVideo = document.getElementById('btnCallVideo');
const callOverlay = document.getElementById('callOverlay');
const callAvatarEl = document.getElementById('callAvatar');
const callNameEl = document.getElementById('callName');
const callTypeEl = document.getElementById('callType');
const btnAcceptCall = document.getElementById('btnAcceptCall');
const btnRejectCall = document.getElementById('btnRejectCall');
const callMediaWrapper = document.getElementById('callMediaWrapper');
const localVideoEl = document.getElementById('localVideo');
const remoteVideoEl = document.getElementById('remoteVideo');

// --- 3. LOGIC KHỞI ĐỘNG ---
async function boot(name) {
  socket.emit('set_username', name, (res) => {
    if (!res.ok) {
      alert(res.error || 'Tên này không hợp lệ hoặc đã có người dùng!');
      localStorage.removeItem('chat_username');
      window.location.href = 'login.html';
      return;
    }

    username = name;
    if (me) me.textContent = username;

    // Cập nhật thông tin profile
    if (profileNameValue) {
      profileNameValue.textContent = username;
    }

    const emailLS = localStorage.getItem('chat_email');
    if (profileEmailValue) {
      profileEmailValue.textContent = emailLS || 'Không có (guest)';
    }

    const typeLS = localStorage.getItem('chat_type');
    if (profileTypeValue) {
      profileTypeValue.textContent =
        typeLS === 'guest' ? 'Khách (Guest)' : 'Tài khoản Firebase';
    }

    // Tải danh sách phòng và vào phòng general
    ['general'].concat(res.rooms.filter(x => x !== 'general')).forEach(addRoom);
    setTargetRoom('general');
    refreshUsers(res.usersOnline || []);
    loadRoomHistory('general');
  });
}

// --- 4. HÀM XỬ LÝ HIỂN THỊ ---

function isImage(filename) {
  return /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(filename || '');
}

function isAudio(filename) {
  return /\.(webm|mp3|wav|ogg)$/i.test(filename || '');
}

function appendMessage({ _id, content, sender, createdAt, isPrivate, system, readBy }, css = '') {
  const li = document.createElement('li');
  if (_id) li.dataset.id = _id;
  if (css) li.classList.add(css);

  if (!system && sender) {
    li.setAttribute('data-sender-initial', sender.charAt(0).toUpperCase());
  }

  if (system) {
    li.classList.add('system');
    li.innerHTML = `<i class='bx bx-info-circle'></i> ${content}`;
  } else {
    const time = createdAt
      ? new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    const prefix = isPrivate ? `[DM] ${sender}` : sender;

    if (sender === username) li.classList.add('me');

    li.innerHTML = `
      <strong>${prefix}</strong>
      ${content}
      <small style="display:block; margin-top:4px; font-size:0.7em; opacity:0.6; text-align:right;">${time}</small>
    `;

    // Hiển thị "Đã xem"
    if (sender === username && Array.isArray(readBy) && readBy.length > 0) {
      const readEl = document.createElement('div');
      readEl.className = 'read-flag';
      readEl.textContent = 'Đã xem';
      li.appendChild(readEl);
    }
  }

  if (messages) {
    messages.appendChild(li);
    messages.scrollTop = messages.scrollHeight;
  }
}

// --- 5. SOCKET EVENTS (NHẬN TIN) ---

socket.on('chat_message', (payload) => {
  appendMessage(payload);
  if (payload.sender !== username && payload.room === currentRoom && payload._id) {
    socket.emit('message_read', { messageId: payload._id });
  }
});

socket.on('private_message', (payload) => {
  appendMessage(payload, payload.sender === username ? 'me' : '');
  if (payload.sender !== username && payload._id) {
    socket.emit('message_read', { messageId: payload._id });
  }
});

// FILE / ẢNH / AUDIO
socket.on('fileMessage', ({ username: sender, url, original, size, timestamp }) => {
  if (!messages) return;

  const sizeMB = (size / (1024 * 1024)).toFixed(2);
  const li = document.createElement('li');
  if (sender === username) li.classList.add('me');

  let contentHtml = '';

  if (isImage(original)) {
    // Ảnh
    contentHtml = `
      <div class="msg-image-container">
        <a href="${url}" target="_blank">
          <img src="${url}" alt="${original}" class="msg-image" />
        </a>
      </div>`;
  } else if (isAudio(original)) {
    // Audio (voice)
    contentHtml = `
      <div class="msg-file">
        <i class='bx bx-microphone'></i> 
        <a href="${url}" target="_blank">${original}</a> 
        <span>(${sizeMB} MB)</span>
        <audio controls src="${url}" style="display:block; margin-top:5px;"></audio>
      </div>`;
  } else {
    // File thường
    contentHtml = `
      <div class="msg-file">
        <i class='bx bx-file'></i> 
        <a href="${url}" target="_blank">${original}</a> 
        <span>(${sizeMB} MB)</span>
      </div>`;
  }

  li.innerHTML = `
    ${sender !== username ? `<strong>${sender}</strong>` : ''}
    ${contentHtml}
    <small style="display:block; margin-top:5px; font-size:0.7em; opacity:0.7; text-align:right;">
      ${new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </small>
  `;

  messages.appendChild(li);
  messages.scrollTop = messages.scrollHeight;
});

socket.on('typing', ({ room, username: user, isTyping }) => {
  if (room !== currentRoom || !typingStatus) return;
  typingStatus.textContent = isTyping ? `${user} đang soạn tin...` : '';
});

socket.on('users_online', (list) => refreshUsers(list || []));
socket.on('system', (text) => appendMessage({ content: text, system: true }));

socket.on('message_read', ({ messageId }) => {
  const li = document.querySelector(`li[data-id="${messageId}"]`);
  if (li && li.classList.contains('me') && !li.querySelector('.read-flag')) {
    const flag = document.createElement('div');
    flag.className = 'read-flag';
    flag.textContent = 'Đã xem';
    li.appendChild(flag);
  }
});

// --- 6. CÁC HÀM HỖ TRỢ (ROOM, USER LIST) ---
function setTargetRoom(r) {
  dmTarget = '';
  currentRoom = r;
  if (target) target.textContent = `Room: ${r}`;
  if (!roomsBox) return;
  Array.from(roomsBox.children).forEach(el =>
    el.classList.toggle('active', el.dataset.room === r)
  );
  if (usersBox) {
    Array.from(usersBox.children).forEach(li => li.classList.remove('active'));
  }
}

async function setTargetDM(u) {
  dmTarget = u;
  currentRoom = ''; // Không ở room nào khi đang xem DM
  if (target) target.textContent = `DM: ${u}`;

  // tô active user đang chat
  if (usersBox) {
    Array.from(usersBox.children).forEach(li => {
      li.classList.toggle('active', li.textContent === u);
    });
  }

  if (!messages) return;
  messages.innerHTML = '';

  try {
    const res = await fetch(
      `${API_BASE}/api/dm/${encodeURIComponent(username)}/${encodeURIComponent(u)}?limit=50`
    );
    const data = await res.json();
    if (Array.isArray(data)) data.forEach(m => appendMessage(m));
  } catch (e) {
    console.error('Lỗi load DM:', e);
  }
}

function addRoom(name) {
  if (!roomsBox) return;
  if (Array.from(roomsBox.children).some(el => el.dataset.room === name)) return;
  const div = document.createElement('div');
  div.innerHTML = `<i class='bx bx-hash'></i> ${name}`;
  div.className = 'room';
  div.dataset.room = name;
  div.onclick = () => joinRoom(name);
  roomsBox.appendChild(div);
}

function refreshUsers(list) {
  if (!usersBox) return;
  usersBox.innerHTML = '';
  list.filter(u => u !== username).forEach(u => {
    const li = document.createElement('li');
    li.textContent = u;
    li.onclick = () => setTargetDM(u);
    usersBox.appendChild(li);
  });
}

async function loadRoomHistory(room) {
  if (!messages) return;
  messages.innerHTML = '';
  try {
    const res = await fetch(`${API_BASE}/api/rooms/${encodeURIComponent(room)}/messages?limit=50`);
    const data = await res.json();
    if (Array.isArray(data)) data.forEach(m => appendMessage(m));
  } catch (e) {
    console.error(e);
  }
}

function joinRoom(room) {
  socket.emit('join_room', room, (res) => {
    if (!res.ok) return;
    addRoom(room);
    setTargetRoom(room);
    if (messages) messages.innerHTML = '';
    (res.history || []).forEach(m => appendMessage(m));
  });
}

// --- 7. SỰ KIỆN NGƯỜI DÙNG ---

// Tạo phòng
const btnCreateRoom = $('#btnCreateRoom');
const roomNameInput = $('#roomName');

if (btnCreateRoom && roomNameInput) {
  btnCreateRoom.onclick = () => {
    const name = roomNameInput.value.trim();
    if (name) { joinRoom(name); roomNameInput.value = ''; }
  };
}

// Về sảnh
const btnToGeneral = $('#toGeneral');
if (btnToGeneral) {
  btnToGeneral.onclick = () => {
    setTargetRoom('general');
    loadRoomHistory('general');
    if (usersBox) {
      Array.from(usersBox.children).forEach(li => li.classList.remove('active'));
    }
  };
}

// Đăng xuất (localStorage)
if (btnLogout) {
  btnLogout.onclick = () => {
    if (confirm('Bạn muốn đăng xuất?')) {
      localStorage.removeItem('chat_username');
      localStorage.removeItem('chat_email');
      localStorage.removeItem('chat_type');
      localStorage.removeItem('chat_avatar');
      window.location.href = 'login.html';
    }
  };
}

// Gửi tin nhắn
if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = (input && input.value.trim()) || '';
    if (!text) return;

    if (dmTarget) {
      socket.emit('private_message', { to: dmTarget, content: text }, () => {});
    } else {
      socket.emit('chat_message', { room: currentRoom, content: text }, () => {});
    }

    if (input) {
      input.value = '';
      input.focus();
    }
    socket.emit('typing', { room: currentRoom, isTyping: false });
  });
}

// Báo đang gõ
if (input) {
  input.addEventListener('input', () => {
    if (!currentRoom) return;
    socket.emit('typing', { room: currentRoom, isTyping: true });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(
      () => socket.emit('typing', { room: currentRoom, isTyping: false }),
      800
    );
  });
}

// Upload File
if (fileUploadBtn && fileInput) {
  fileUploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('room', currentRoom);
    formData.append('username', username);
    try {
      const res = await fetch(`${API_BASE}/upload-file`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!data.ok) alert('Lỗi upload: ' + (data.message || 'Thất bại'));
      fileInput.value = '';
    } catch (err) {
      alert('Lỗi upload: ' + err.message);
    }
  };
}

// --- 8. DARK / LIGHT MODE ---
const toggleBtn = document.getElementById('toggleMode');

if (toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    document.body.classList.toggle('dark');

    const theme = document.body.classList.contains('dark') ? 'dark' : 'light';
    localStorage.setItem('theme', theme);

    toggleBtn.innerHTML = theme === 'dark'
      ? "<i class='bx bx-sun'></i>"
      : "<i class='bx bx-moon'></i>";
  });

  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') {
    document.body.classList.add('dark');
    toggleBtn.innerHTML = "<i class='bx bx-sun'></i>";
  }
}

// --- 9. AVATAR SIDEBAR ---
const avatarCircle = document.querySelector('.avatar-circle');
const avatarMenu = document.getElementById('avatarMenu');
const avatarMenuChoose = document.getElementById('avatarMenuChoose');
const avatarMenuClear = document.getElementById('avatarMenuClear');
const avatarMenuInput = document.getElementById('avatarMenuInput');

function applyAvatar(avatarDataUrl) {
  if (!avatarCircle) return;
  if (avatarDataUrl) {
    avatarCircle.style.backgroundImage = `url(${avatarDataUrl})`;
    avatarCircle.style.backgroundSize = 'cover';
    avatarCircle.style.backgroundPosition = 'center';
    avatarCircle.innerHTML = '';
  } else {
    avatarCircle.style.backgroundImage = 'none';
    avatarCircle.innerHTML = "<i class='bx bxs-user'></i>";
  }
}

const storedAvatar = localStorage.getItem('chat_avatar');
applyAvatar(storedAvatar);

if (avatarCircle && avatarMenu) {
  avatarCircle.addEventListener('click', (e) => {
    e.stopPropagation();
    avatarMenu.style.display = avatarMenu.style.display === 'block' ? 'none' : 'block';
  });

  document.addEventListener('click', (e) => {
    if (!avatarMenu.contains(e.target) && !avatarCircle.contains(e.target)) {
      avatarMenu.style.display = 'none';
    }
  });

  if (avatarMenuChoose && avatarMenuInput) {
    avatarMenuChoose.addEventListener('click', () => {
      avatarMenuInput.click();
    });

    avatarMenuInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        localStorage.setItem('chat_avatar', dataUrl);
        applyAvatar(dataUrl);
        avatarMenu.style.display = 'none';
        avatarMenuInput.value = '';
      };
      reader.readAsDataURL(file);
    });
  }

  if (avatarMenuClear) {
    avatarMenuClear.addEventListener('click', () => {
      localStorage.removeItem('chat_avatar');
      applyAvatar(null);
      avatarMenu.style.display = 'none';
    });
  }
}

// ---  10. VOICE MESSAGE (Tin nhắn thoại) ---
let mediaRecorder = null;
let voiceChunks = [];
const btnRecordVoice = document.getElementById('btnRecordVoice');

async function uploadVoiceBlob(blob) {
  if (!blob || !currentRoom || !username) return;

  const fileName = `voice-${Date.now()}.webm`;
  const file = new File([blob], fileName, { type: 'audio/webm' });

  const formData = new FormData();
  formData.append('file', file);
  formData.append('room', currentRoom);
  formData.append('username', username);

  try {
    const res = await fetch(`${API_BASE}/upload-file`, {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!data.ok) {
      alert('Gửi tin nhắn thoại thất bại: ' + (data.message || 'Lỗi không rõ'));
    }
  } catch (err) {
    console.error(err);
    alert('Lỗi khi gửi tin nhắn thoại: ' + err.message);
  }
}

if (btnRecordVoice && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
  btnRecordVoice.addEventListener('click', async () => {
    try {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        voiceChunks = [];
        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            voiceChunks.push(e.data);
          }
        };

        mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          btnRecordVoice.classList.remove('recording');

          if (voiceChunks.length === 0) return;
          const audioBlob = new Blob(voiceChunks, { type: 'audio/webm' });
          await uploadVoiceBlob(audioBlob);
        };

        mediaRecorder.start();
        btnRecordVoice.classList.add('recording');
      } else if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    } catch (err) {
      console.error('Lỗi khi truy cập micro:', err);
      alert('Không thể truy cập micro. Vui lòng kiểm tra quyền microphone.');
    }
  });
} else if (btnRecordVoice) {
  btnRecordVoice.disabled = true;
  btnRecordVoice.title = 'Trình duyệt không hỗ trợ ghi âm';
}

// --- 11. WEBRTC CALL (VOICE + VIDEO 1–1) ---

function clearCallTimeout() {
  if (callTimeoutId) {
    clearTimeout(callTimeoutId);
    callTimeoutId = null;
  }
}

function openCallOverlay(displayName, isVideo, mode) {
  // mode: 'outgoing' | 'incoming' | 'in-call'
  if (!callOverlay) return;
  callOverlay.style.display = 'flex';

  if (callAvatarEl) {
    callAvatarEl.textContent = (displayName || '?').charAt(0).toUpperCase();
  }

  if (callNameEl) {
    if (mode === 'incoming') {
      callNameEl.textContent = displayName ? `Cuộc gọi từ ${displayName}` : 'Cuộc gọi đến';
    } else {
      callNameEl.textContent = displayName || 'Đang gọi...';
    }
  }

  if (callTypeEl) {
    if (mode === 'incoming') {
      callTypeEl.textContent = isVideo ? 'Video call đến' : 'Voice call đến';
    } else if (mode === 'in-call') {
      callTypeEl.textContent = isVideo ? 'Đang trong video call' : 'Đang trong voice call';
    } else {
      callTypeEl.textContent = isVideo ? 'Đang gọi video...' : 'Đang gọi thoại...';
    }
  }

  if (callMediaWrapper) {
    callMediaWrapper.style.display = isVideo ? 'block' : 'none';
  }

  if (btnAcceptCall) {
    btnAcceptCall.style.display = (mode === 'incoming') ? 'inline-flex' : 'none';
  }
  if (btnRejectCall) {
    btnRejectCall.style.display = 'inline-flex';
  }

  if (!isVideo && !remoteAudioEl) {
    remoteAudioEl = document.createElement('audio');
    remoteAudioEl.autoplay = true;
    remoteAudioEl.style.display = 'none';
    document.body.appendChild(remoteAudioEl);
  }

  if (isVideo && localVideoEl && localStream) {
    localVideoEl.srcObject = localStream;
  }
}

function closeCallOverlay() {
  if (!callOverlay) return;
  callOverlay.style.display = 'none';
  if (callMediaWrapper) callMediaWrapper.style.display = 'none';
}

function createPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  pc.onicecandidate = (event) => {
    if (event.candidate && currentCallPeer) {
      socket.emit('ice_candidate', {
        to: currentCallPeer,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
  const [stream] = event.streams;
  if (!stream) return;

  if (currentCallIsVideo && remoteVideoEl) {
    remoteVideoEl.srcObject = stream;
    // NEW (tuỳ chọn)
    remoteVideoEl.play().catch(() => {});
  } else if (!currentCallIsVideo && remoteAudioEl) {
    remoteAudioEl.srcObject = stream;
    // NEW (tuỳ chọn)
    remoteAudioEl.play().catch(() => {});
  }
    if (currentCallIsVideo && remoteVideoEl) {
      remoteVideoEl.srcObject = stream;
    } else if (!currentCallIsVideo && remoteAudioEl) {
      remoteAudioEl.srcObject = stream;
    }
  };
}

function resetCallState(closeOverlay = true) {
  clearCallTimeout();

  if (pc) {
    pc.close();
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  if (remoteAudioEl) remoteAudioEl.srcObject = null;
  if (remoteVideoEl) remoteVideoEl.srcObject = null;
  if (localVideoEl) localVideoEl.srcObject = null;

  incomingOffer = null;
  currentCallPeer = null;
  currentCallIsVideo = false;
  currentCallStatus = 'idle';

  if (closeOverlay) closeCallOverlay();
}

// ==== CALL NHÓM (ROOM) ====
async function joinGroupCall(isVideo) {
  if (!currentRoom) {
    alert('Bạn cần đang ở một phòng để gọi phòng.');
    return;
  }
  if (groupCallActive) {
    alert('Bạn đã ở trong cuộc gọi phòng này.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Trình duyệt không hỗ trợ WebRTC / getUserMedia.');
    return;
  }

  groupCallRoom = currentRoom;
  const constraints = { audio: true, video: !!isVideo };

  try {
    groupLocalStream = await navigator.mediaDevices.getUserMedia(constraints);
    groupCallActive = true;

    openCallOverlay(`Phòng ${groupCallRoom}`, !!isVideo, 'in-call');

    if (isVideo && localVideoEl) {
      localVideoEl.srcObject = groupLocalStream;
    } else if (localVideoEl) {
      localVideoEl.srcObject = null;
    }

    socket.emit('room_call_join', { room: groupCallRoom }, (res) => {
      if (!res || !res.ok) {
        alert('Không thể tham gia cuộc gọi phòng.');
        leaveGroupCall();
      }
      // res.participants: những người đã ở trong call trước mình
    });
  } catch (err) {
    console.error('Lỗi joinGroupCall:', err);
    alert('Không thể truy cập mic/camera: ' + err.message);
    leaveGroupCall();
  }
}

function createGroupPeerConnection(peerName) {
  if (groupPeers[peerName]) return groupPeers[peerName];

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  pc.onicecandidate = (event) => {
    if (event.candidate && groupCallActive && groupCallRoom) {
      socket.emit('room_call_signal', {
        room: groupCallRoom,
        to: peerName,
        type: 'candidate',
        data: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) return;

    groupRemoteStreams[peerName] = stream;

    if (remoteVideoEl) {
      remoteVideoEl.srcObject = stream;
    } else {
      if (!remoteAudioEl) {
        remoteAudioEl = document.createElement('audio');
        remoteAudioEl.autoplay = true;
        remoteAudioEl.style.display = 'none';
        document.body.appendChild(remoteAudioEl);
      }
      remoteAudioEl.srcObject = stream;
    }
  };

  if (groupLocalStream) {
    groupLocalStream.getTracks().forEach(track => pc.addTrack(track, groupLocalStream));
  }

  groupPeers[peerName] = pc;
  return pc;
}

function leaveGroupCall() {
  if (!groupCallActive) return;

  if (groupCallRoom) {
    socket.emit('room_call_leave', { room: groupCallRoom });
  }

  Object.values(groupPeers).forEach(pc => pc.close());
  groupPeers = {};
  groupRemoteStreams = {};

  if (groupLocalStream) {
    groupLocalStream.getTracks().forEach(t => t.stop());
    groupLocalStream = null;
  }

  groupCallActive = false;
  groupCallRoom = null;

  if (remoteVideoEl) remoteVideoEl.srcObject = null;
  if (localVideoEl) localVideoEl.srcObject = null;
  if (remoteAudioEl) remoteAudioEl.srcObject = null;

  closeCallOverlay();
}

// Chỉ còn 1 hàm startDirectCall duy nhất
async function startDirectCall(isVideo) {

  currentCallPeer = dmTarget;
  currentCallIsVideo = !!isVideo;
  currentCallStatus = 'outgoing';

  try {
    const constraints = { audio: true, video: !!isVideo };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);

    async function startDirectCall(isVideo) {
  if (!dmTarget) {
    alert('Hãy chọn 1 người (DM) rồi mới gọi 1-1.');
    return;
  }
  if (groupCallActive) {
    const ok = confirm('Bạn đang ở cuộc gọi phòng, rời cuộc gọi phòng trước khi gọi 1-1?');
    if (!ok) return;
    leaveGroupCall();
  }

  if (currentCallStatus !== 'idle') {
    alert('Bạn đang trong một cuộc gọi khác.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Trình duyệt không hỗ trợ WebRTC / getUserMedia.');
    return;
  }

  // >>> NEW: nếu đang ghi âm voice thì dừng lại để giải phóng micro
  if (typeof mediaRecorder !== 'undefined' &&
      mediaRecorder &&
      mediaRecorder.state === 'recording') {
    try {
      mediaRecorder.stop();
    } catch (e) {
      console.warn('Không dừng được mediaRecorder:', e);
    }
  }

  currentCallPeer = dmTarget;
  currentCallIsVideo = !!isVideo;
  currentCallStatus = 'outgoing';

  try {
    const constraints = { audio: true, video: !!isVideo };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);

    createPeerConnection();
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    if (currentCallIsVideo && localVideoEl) {
      localVideoEl.srcObject = localStream;
    }

    openCallOverlay(currentCallPeer, currentCallIsVideo, 'outgoing');

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('call_user', {
      to: currentCallPeer,
      offer,
      isVideo: currentCallIsVideo
    });

    callTimeoutId = setTimeout(() => {
      if (currentCallStatus === 'outgoing' && currentCallPeer) {
        const peer = currentCallPeer;
        alert('Không có phản hồi, cuộc gọi đã bị huỷ.');
        socket.emit('end_call', { to: peer });
        resetCallState(true);
      }
    }, 30000);
  } catch (err) {
    console.error('Lỗi khi bắt đầu call:', err);
    alert('Không thể bắt đầu cuộc gọi: ' + err.message);
    resetCallState(true);
  }
}


    createPeerConnection();
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    if (currentCallIsVideo && localVideoEl) {
      localVideoEl.srcObject = localStream;
    }

    openCallOverlay(currentCallPeer, currentCallIsVideo, 'outgoing');

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('call_user', {
      to: currentCallPeer,
      offer,
      isVideo: currentCallIsVideo
    });

    // timeout 30s không trả lời
    callTimeoutId = setTimeout(() => {
      if (currentCallStatus === 'outgoing' && currentCallPeer) {
        const peer = currentCallPeer;
        alert('Không có phản hồi, cuộc gọi đã bị huỷ.');
        socket.emit('end_call', { to: peer });
        resetCallState(true);
      }
    }, 30000);
  } catch (err) {
    console.error('Lỗi khi bắt đầu call:', err);
    alert('Không thể bắt đầu cuộc gọi: ' + err.message);
    resetCallState(true);
  }
}


async function acceptIncomingCall() {
  if (currentCallStatus !== 'ringing' || !incomingOffer || !currentCallPeer) return;

  clearCallTimeout();

  if (typeof mediaRecorder !== 'undefined' &&
      mediaRecorder &&
      mediaRecorder.state === 'recording') {
    try {
      mediaRecorder.stop();
    } catch (e) {
      console.warn('Không dừng được mediaRecorder:', e);
    }
  }
  
  try {
    const constraints = { audio: true, video: !!currentCallIsVideo };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);

    createPeerConnection();
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    if (currentCallIsVideo && localVideoEl) {
      localVideoEl.srcObject = localStream;
    }

    await pc.setRemoteDescription(new RTCSessionDescription(incomingOffer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    currentCallStatus = 'in-call';
    openCallOverlay(currentCallPeer, currentCallIsVideo, 'in-call');

    socket.emit('answer_call', {
      to: currentCallPeer,
      answer
    });
  } catch (err) {
    console.error('Lỗi khi nhận cuộc gọi:', err);
    alert('Không thể nhận cuộc gọi: ' + err.message);
    if (currentCallPeer) {
      socket.emit('reject_call', { to: currentCallPeer, reason: 'error' });
    }
    resetCallState(true);
  }
}

function handleCallButton(isVideo) {
  if (dmTarget) {
    // Gọi 1-1
    startDirectCall(isVideo);
  } else {
    // Nếu không chọn DM thì dùng call phòng
    if (!groupCallActive) {
      joinGroupCall(isVideo);
    } else {
      const ok = confirm('Bạn muốn rời cuộc gọi phòng hiện tại?');
      if (ok) leaveGroupCall();
    }
  }
}


// ==== GẮN SỰ KIỆN NÚT GỌI / ĐỒNG Ý / TỪ CHỐI ====
if (btnCallVoice) {
  btnCallVoice.addEventListener('click', () => handleCallButton(false));
}
if (btnCallVideo) {
  btnCallVideo.addEventListener('click', () => handleCallButton(true));
}

if (btnAcceptCall) {
  btnAcceptCall.addEventListener('click', () => {
    if (currentCallStatus === 'ringing') {
      acceptIncomingCall();
    }
  });
}

if (btnRejectCall) {
  btnRejectCall.addEventListener('click', () => {
    // Call nhóm
    if (groupCallActive) {
      leaveGroupCall();
      return;
    }

    // Call 1-1
    if (currentCallStatus === 'ringing' && currentCallPeer) {
      socket.emit('reject_call', { to: currentCallPeer, reason: 'decline' });
      resetCallState(true);
    } else if ((currentCallStatus === 'outgoing' || currentCallStatus === 'in-call') && currentCallPeer) {
      const peer = currentCallPeer;
      socket.emit('end_call', { to: peer });
      resetCallState(true);
    }
  });
}

window.addEventListener('beforeunload', () => {
  if (groupCallActive) {
    socket.emit('room_call_leave', { room: groupCallRoom });
  }
  if (currentCallPeer && currentCallStatus !== 'idle') {
    socket.emit('end_call', { to: currentCallPeer });
  }
});

// ==== SIGNALING TỪ SERVER ====

// Khi có cuộc gọi đến
socket.on('incoming_call', ({ from, offer, isVideo }) => {
  if (currentCallStatus !== 'idle') {
    socket.emit('reject_call', { to: from, reason: 'busy' });
    return;
  }

  currentCallPeer = from;
  currentCallIsVideo = !!isVideo;
  incomingOffer = offer;
  currentCallStatus = 'ringing';

  openCallOverlay(from, currentCallIsVideo, 'incoming');

  // Thời gian chờ cho người nhận: 30s không bấm -> tự từ chối
  callTimeoutId = setTimeout(() => {
    if (currentCallStatus === 'ringing' && currentCallPeer) {
      const peer = currentCallPeer;
      socket.emit('reject_call', { to: peer, reason: 'no_answer' });
      resetCallState(true);
    }
  }, 30000);
});

// Khi người nhận đã đồng ý và gửi answer
socket.on('call_answered', async ({ from, answer }) => {
  if (!pc || !currentCallPeer || from !== currentCallPeer) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    currentCallStatus = 'in-call';
    openCallOverlay(currentCallPeer, currentCallIsVideo, 'in-call');
    clearCallTimeout();
  } catch (err) {
    console.error('Lỗi setRemoteDescription answer:', err);
  }
});

// Nhận ICE candidate
socket.on('ice_candidate', async ({ from, candidate }) => {
  if (!pc || !currentCallPeer || from !== currentCallPeer) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Lỗi addIceCandidate:', err);
  }
});

// Bị từ chối
socket.on('call_rejected', ({ from, reason }) => {
  if (!currentCallPeer || from !== currentCallPeer) return;

  let msg = 'Cuộc gọi đã bị từ chối.';
  if (reason === 'busy') msg = 'Người nhận đang bận.';
  if (reason === 'no_answer') msg = 'Người nhận không trả lời.';

  alert(msg);
  resetCallState(true);
});

// Đầu bên kia kết thúc cuộc gọi
socket.on('call_ended', ({ from }) => {
  if (!currentCallPeer || from !== currentCallPeer) return;
  alert('Cuộc gọi đã kết thúc.');
  resetCallState(true);
});

// ==== ROOM GROUP CALL (mesh) ====

// Khi có người khác join vào call phòng
socket.on('room_call_joined', async ({ room, user }) => {
  if (!groupCallActive || room !== groupCallRoom) return;
  if (user === username) return;

  try {
    const pc = createGroupPeerConnection(user);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('room_call_signal', {
      room: groupCallRoom,
      to: user,
      type: 'offer',
      data: offer
    });
  } catch (err) {
    console.error('Lỗi khi gửi offer tới', user, err);
  }
});

// Nhận tín hiệu WebRTC trong call phòng
socket.on('room_call_signal', async ({ room, from, type, data }) => {
  if (!groupCallActive || room !== groupCallRoom) return;
  if (from === username) return;

  const pc = createGroupPeerConnection(from);

  try {
    if (type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('room_call_signal', {
        room: groupCallRoom,
        to: from,
        type: 'answer',
        data: answer
      });
    } else if (type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (type === 'candidate') {
      await pc.addIceCandidate(new RTCIceCandidate(data));
    }
  } catch (err) {
    console.error('Lỗi xử lý room_call_signal', type, 'từ', from, err);
  }
});

// Peer khác rời call phòng
socket.on('room_call_left', ({ room, user }) => {
  if (!groupCallActive || room !== groupCallRoom) return;

  const pc = groupPeers[user];
  if (pc) {
    pc.close();
    delete groupPeers[user];
  }
  delete groupRemoteStreams[user];
});
