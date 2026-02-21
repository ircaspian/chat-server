const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data.json');

// Load data
let data = {
  users: {},
  messages: {},
  chats: {},
  blocked: {},
  blockedBy: {},
  pinnedChats: {},
  pinnedMessages: {}
};

if (fs.existsSync(DATA_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.log('Error loading data, starting fresh');
  }
}

// Save data
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Generate recovery code
function generateRecoveryCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Online users
const onlineUsers = new Map();

// HTTP server
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      users: Object.keys(data.users).length,
      online: onlineUsers.size
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// WebSocket server
const wss = new WebSocketServer({ server });

// Helper functions
function getChatId(user1, user2) {
  return [user1, user2].sort().join(':');
}

function broadcast(message, excludeWs = null) {
  const msg = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function sendTo(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function sendToUser(userId, type, messageData) {
  const userWs = onlineUsers.get(userId);
  if (userWs && userWs.readyState === WebSocket.OPEN) {
    sendTo(userWs, type, messageData);
  }
}

function getOnlineUserIds() {
  return Array.from(onlineUsers.keys());
}

function ensureChat(userId, partnerId) {
  if (!data.chats[userId]) data.chats[userId] = {};
  if (!data.chats[userId][partnerId]) {
    data.chats[userId][partnerId] = {
      partnerId: partnerId,
      lastMessage: null,
      unreadCount: 0,
      updatedAt: Date.now()
    };
  }
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  let currentUserId = null;
  
  console.log('📱 New connection');
  sendTo(ws, 'connected', { timestamp: Date.now() });
  
  ws.on('message', (rawMessage) => {
    try {
      const { type, data: msgData } = JSON.parse(rawMessage.toString());
      
      switch (type) {
        case 'register': {
          const { id, username, displayName, avatar, bio } = msgData;
          
          const existingUser = Object.values(data.users).find(
            u => u.username.toLowerCase() === username.toLowerCase() && u.id !== id
          );
          
          if (existingUser) {
            sendTo(ws, 'register_error', { error: 'این نام کاربری قبلاً استفاده شده' });
            return;
          }
          
          const recoveryCode = generateRecoveryCode();
          
          const user = {
            id,
            username,
            displayName,
            avatar,
            bio,
            isOnline: true,
            lastSeen: Date.now(),
            isDeleted: false,
            recoveryCode
          };
          
          data.users[id] = user;
          data.blocked[id] = data.blocked[id] || [];
          data.blockedBy[id] = data.blockedBy[id] || [];
          data.pinnedChats[id] = data.pinnedChats[id] || [];
          data.pinnedMessages[id] = data.pinnedMessages[id] || {};
          data.chats[id] = data.chats[id] || {};
          
          currentUserId = id;
          onlineUsers.set(id, ws);
          
          saveData();
          
          sendTo(ws, 'register_success', {
            user,
            users: data.users,
            chats: data.chats[id] || {},
            messages: getAllUserMessages(id),
            blocked: data.blocked[id] || [],
            blockedBy: data.blockedBy[id] || [],
            pinnedChats: data.pinnedChats[id] || [],
            pinnedMessages: data.pinnedMessages[id] || {},
            onlineUsers: getOnlineUserIds()
          });
          
          broadcast({ type: 'user_joined', data: { user: { ...user, recoveryCode: undefined }, onlineUsers: getOnlineUserIds() } }, ws);
          break;
        }
        
        case 'login': {
          const { userId } = msgData;
          
          if (!data.users[userId] || data.users[userId].isDeleted) {
            sendTo(ws, 'login_error', { error: 'کاربر یافت نشد' });
            return;
          }
          
          currentUserId = userId;
          onlineUsers.set(userId, ws);
          
          data.users[userId].isOnline = true;
          data.users[userId].lastSeen = Date.now();
          
          // Mark all pending messages as delivered
          const deliveredUpdates = [];
          for (const chatId in data.messages) {
            const [user1, user2] = chatId.split(':');
            if (user1 === userId || user2 === userId) {
              for (const msg of data.messages[chatId]) {
                if (msg.receiverId === userId && msg.status === 'sent') {
                  msg.status = 'delivered';
                  deliveredUpdates.push({ messageId: msg.id, chatId });
                }
              }
            }
          }
          
          saveData();
          
          sendTo(ws, 'login_success', {
            user: data.users[userId],
            users: data.users,
            chats: data.chats[userId] || {},
            messages: getAllUserMessages(userId),
            blocked: data.blocked[userId] || [],
            blockedBy: data.blockedBy[userId] || [],
            pinnedChats: data.pinnedChats[userId] || [],
            pinnedMessages: data.pinnedMessages[userId] || {},
            onlineUsers: getOnlineUserIds()
          });
          
          // Broadcast delivered status to all users
          if (deliveredUpdates.length > 0) {
            broadcast({
              type: 'messages_batch_delivered',
              data: { updates: deliveredUpdates }
            });
          }
          
          broadcast({ 
            type: 'user_online', 
            data: { userId, onlineUsers: getOnlineUserIds() } 
          }, ws);
          break;
        }
        
        case 'login_recovery': {
          const { recoveryCode } = msgData;
          const cleanCode = recoveryCode.replace(/-/g, '').toUpperCase();
          
          const user = Object.values(data.users).find(
            u => u.recoveryCode && u.recoveryCode.replace(/-/g, '') === cleanCode && !u.isDeleted
          );
          
          if (!user) {
            sendTo(ws, 'login_error', { error: 'کد بازیابی نامعتبر است' });
            return;
          }
          
          currentUserId = user.id;
          onlineUsers.set(user.id, ws);
          
          data.users[user.id].isOnline = true;
          data.users[user.id].lastSeen = Date.now();
          
          // Mark all pending messages as delivered
          const deliveredUpdates = [];
          for (const chatId in data.messages) {
            const [user1, user2] = chatId.split(':');
            if (user1 === user.id || user2 === user.id) {
              for (const msg of data.messages[chatId]) {
                if (msg.receiverId === user.id && msg.status === 'sent') {
                  msg.status = 'delivered';
                  deliveredUpdates.push({ messageId: msg.id, chatId });
                }
              }
            }
          }
          
          saveData();
          
          sendTo(ws, 'login_success', {
            user: data.users[user.id],
            users: data.users,
            chats: data.chats[user.id] || {},
            messages: getAllUserMessages(user.id),
            blocked: data.blocked[user.id] || [],
            blockedBy: data.blockedBy[user.id] || [],
            pinnedChats: data.pinnedChats[user.id] || [],
            pinnedMessages: data.pinnedMessages[user.id] || {},
            onlineUsers: getOnlineUserIds()
          });
          
          // Broadcast delivered status to all users
          if (deliveredUpdates.length > 0) {
            broadcast({
              type: 'messages_batch_delivered',
              data: { updates: deliveredUpdates }
            });
          }
          
          broadcast({ 
            type: 'user_online', 
            data: { userId: user.id, onlineUsers: getOnlineUserIds() } 
          }, ws);
          break;
        }
        
        case 'check_username': {
          const { username, excludeId } = msgData;
          const exists = Object.values(data.users).some(
            u => u.username.toLowerCase() === username.toLowerCase() && u.id !== excludeId && !u.isDeleted
          );
          sendTo(ws, 'username_check_result', { exists });
          break;
        }
        
        case 'search_user': {
          const { username } = msgData;
          const searchTerm = username.replace('@', '').toLowerCase();
          const user = Object.values(data.users).find(
            u => u.username.toLowerCase() === searchTerm && !u.isDeleted
          );
          sendTo(ws, 'search_result', { user: user ? { ...user, recoveryCode: undefined } : null });
          break;
        }
        
        case 'send_message': {
          if (!currentUserId) return;
          
          const { id, chatId, senderId, receiverId, text, replyTo } = msgData;
          
          if (data.blocked[receiverId]?.includes(senderId)) {
            sendTo(ws, 'message_blocked', { error: 'شما توسط این کاربر بلاک شده‌اید' });
            return;
          }
          
          if (data.users[receiverId]?.isDeleted) {
            sendTo(ws, 'message_blocked', { error: 'این کاربر حذف شده است' });
            return;
          }
          
          const message = {
            id,
            chatId,
            senderId,
            receiverId,
            text,
            replyTo,
            timestamp: Date.now(),
            status: 'sent',
            isEdited: false,
            isDeleted: false,
            reactions: []
          };
          
          if (!data.messages[chatId]) data.messages[chatId] = [];
          data.messages[chatId].push(message);
          
          ensureChat(senderId, receiverId);
          ensureChat(receiverId, senderId);
          
          data.chats[senderId][receiverId].lastMessage = message;
          data.chats[senderId][receiverId].updatedAt = Date.now();
          
          data.chats[receiverId][senderId].lastMessage = message;
          data.chats[receiverId][senderId].updatedAt = Date.now();
          data.chats[receiverId][senderId].unreadCount = 
            (data.chats[receiverId][senderId].unreadCount || 0) + 1;
          
          saveData();
          
          sendTo(ws, 'message_sent', { 
            message: { ...message, status: 'sent' },
            chats: data.chats[senderId]
          });
          
          const receiverWs = onlineUsers.get(receiverId);
          if (receiverWs) {
            message.status = 'delivered';
            sendTo(receiverWs, 'new_message', { 
              message,
              chats: data.chats[receiverId],
              senderId
            });
            
            sendTo(ws, 'message_delivered', { messageId: id, chatId });
          }
          
          break;
        }
        
        case 'edit_message': {
          const { chatId, messageId, newText } = msgData;
          
          if (data.messages[chatId]) {
            const msg = data.messages[chatId].find(m => m.id === messageId);
            if (msg && msg.senderId === currentUserId) {
              msg.text = newText;
              msg.isEdited = true;
              saveData();
              
              const [user1, user2] = chatId.split(':');
              [user1, user2].forEach(userId => {
                sendToUser(userId, 'message_edited', { chatId, messageId, newText });
              });
            }
          }
          break;
        }
        
        case 'delete_message': {
          const { chatId, messageIds } = msgData;
          
          if (data.messages[chatId]) {
            // First, remove deleted messages from pinned messages for both users
            const [user1, user2] = chatId.split(':');
            [user1, user2].forEach(userId => {
              if (data.pinnedMessages[userId]?.[chatId]) {
                data.pinnedMessages[userId][chatId] = 
                  data.pinnedMessages[userId][chatId].filter(id => !messageIds.includes(id));
              }
            });
            
            // Then delete the messages
            data.messages[chatId] = data.messages[chatId].filter(
              m => !messageIds.includes(m.id)
            );
            saveData();
            
            // Notify both users with updated pinned messages
            [user1, user2].forEach(userId => {
              sendToUser(userId, 'message_deleted', { 
                chatId, 
                messageIds,
                pinnedMessages: data.pinnedMessages[userId]?.[chatId] || []
              });
            });
          }
          break;
        }
        
        case 'mark_seen': {
          const { chatId, userId, partnerId } = msgData;
          
          if (data.messages[chatId]) {
            data.messages[chatId].forEach(m => {
              if (m.receiverId === userId && m.status !== 'seen') {
                m.status = 'seen';
              }
            });
          }
          
          if (data.chats[userId]?.[partnerId]) {
            data.chats[userId][partnerId].unreadCount = 0;
          }
          
          saveData();
          
          sendToUser(partnerId, 'messages_seen', { chatId, seenBy: userId });
          sendTo(ws, 'unread_cleared', { partnerId });
          break;
        }
        
        case 'mark_messages_seen': {
          const { chatId, userId, partnerId, messageIds } = msgData;
          
          if (!messageIds || messageIds.length === 0) break;
          
          // Mark only the specified messages as seen
          if (data.messages[chatId]) {
            data.messages[chatId].forEach(m => {
              if (messageIds.includes(m.id) && m.receiverId === userId && m.status !== 'seen') {
                m.status = 'seen';
              }
            });
          }
          
          // Update unread count
          if (data.chats[userId]?.[partnerId]) {
            const currentUnread = data.chats[userId][partnerId].unreadCount || 0;
            data.chats[userId][partnerId].unreadCount = Math.max(0, currentUnread - messageIds.length);
          }
          
          saveData();
          
          // Notify the sender that specific messages were seen
          sendToUser(partnerId, 'specific_messages_seen', { 
            chatId, 
            seenBy: userId, 
            messageIds 
          });
          
          // Also send updated chat data to the current user so sidebar updates
          sendToUser(userId, 'chat_unread_updated', {
            partnerId,
            unreadCount: Math.max(0, (data.chats[userId]?.[partnerId]?.unreadCount || 0))
          });
          break;
        }
        
        case 'typing': {
          const { userId, partnerId, isTyping } = msgData;
          sendToUser(partnerId, 'user_typing', { userId, isTyping });
          break;
        }
        
        case 'update_profile': {
          const { userId, updates } = msgData;
          
          if (updates.username) {
            const exists = Object.values(data.users).some(
              u => u.username.toLowerCase() === updates.username.toLowerCase() && 
                   u.id !== userId && !u.isDeleted
            );
            if (exists) {
              sendTo(ws, 'profile_error', { error: 'این نام کاربری قبلاً استفاده شده' });
              return;
            }
          }
          
          data.users[userId] = { ...data.users[userId], ...updates };
          saveData();
          
          sendTo(ws, 'profile_updated', { user: data.users[userId] });
          broadcast({ type: 'user_updated', data: { user: { ...data.users[userId], recoveryCode: undefined } } }, ws);
          break;
        }
        
        case 'delete_account': {
          if (!currentUserId) return;
          
          data.users[currentUserId] = {
            ...data.users[currentUserId],
            displayName: 'کاربر حذف شده',
            username: `deleted_${currentUserId}`,
            avatar: '👤',
            bio: '',
            isDeleted: true,
            isOnline: false,
            recoveryCode: null
          };
          
          saveData();
          
          sendTo(ws, 'account_deleted', {});
          broadcast({ type: 'user_deleted', data: { 
            userId: currentUserId, 
            user: data.users[currentUserId] 
          }});
          
          onlineUsers.delete(currentUserId);
          currentUserId = null;
          break;
        }
        
        case 'block_user': {
          const { userId, targetId, isBlocked } = msgData;
          
          if (!data.blocked[userId]) data.blocked[userId] = [];
          if (!data.blockedBy[targetId]) data.blockedBy[targetId] = [];
          
          if (isBlocked) {
            if (!data.blocked[userId].includes(targetId)) {
              data.blocked[userId].push(targetId);
            }
            if (!data.blockedBy[targetId].includes(userId)) {
              data.blockedBy[targetId].push(userId);
            }
          } else {
            data.blocked[userId] = data.blocked[userId].filter(id => id !== targetId);
            data.blockedBy[targetId] = data.blockedBy[targetId].filter(id => id !== userId);
          }
          
          saveData();
          
          sendTo(ws, 'user_blocked', { blocked: data.blocked[userId] });
          sendToUser(targetId, 'you_were_blocked', { blockedBy: data.blockedBy[targetId] });
          break;
        }
        
        case 'pin_chat': {
          const { userId, partnerId, isPinned } = msgData;
          
          if (!data.pinnedChats[userId]) data.pinnedChats[userId] = [];
          
          if (isPinned) {
            if (!data.pinnedChats[userId].includes(partnerId)) {
              data.pinnedChats[userId].push(partnerId);
            }
          } else {
            data.pinnedChats[userId] = data.pinnedChats[userId].filter(id => id !== partnerId);
          }
          
          saveData();
          sendTo(ws, 'chat_pinned', { pinnedChats: data.pinnedChats[userId] });
          break;
        }
        
        case 'delete_chat': {
          const { userId, partnerId } = msgData;
          
          if (data.chats[userId]) {
            delete data.chats[userId][partnerId];
          }
          
          const chatId = getChatId(userId, partnerId);
          delete data.messages[chatId];
          
          if (data.pinnedChats[userId]) {
            data.pinnedChats[userId] = data.pinnedChats[userId].filter(id => id !== partnerId);
          }
          
          saveData();
          
          sendTo(ws, 'chat_deleted', { 
            partnerId,
            chats: data.chats[userId] || {}
          });
          break;
        }
        
        case 'pin_message': {
          const { chatId, messageId, isPinned, oderId } = msgData;
          const [user1, user2] = chatId.split(':');
          const isSavedMessages = user1 === user2;
          
          // Update pinned messages for both users
          [user1, user2].forEach(userId => {
            if (!data.pinnedMessages[userId]) data.pinnedMessages[userId] = {};
            if (!data.pinnedMessages[userId][chatId]) data.pinnedMessages[userId][chatId] = [];
            
            if (isPinned) {
              if (!data.pinnedMessages[userId][chatId].includes(messageId)) {
                data.pinnedMessages[userId][chatId].push(messageId);
              }
            } else {
              data.pinnedMessages[userId][chatId] = 
                data.pinnedMessages[userId][chatId].filter(id => id !== messageId);
            }
          });
          
          // Create system message for pin (NOT for saved messages)
          let systemMessage = null;
          if (isPinned && !isSavedMessages) {
            const pinner = data.users[oderId];
            systemMessage = {
              id: `sys_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              chatId,
              senderId: oderId,
              receiverId: user1 === oderId ? user2 : user1,
              text: `${pinner?.displayName || 'کاربر'} پیامی را سنجاق کرد`,
              timestamp: Date.now(),
              status: 'sent',
              isEdited: false,
              isDeleted: false,
              isSystem: true,
              reactions: []
            };
            
            if (!data.messages[chatId]) data.messages[chatId] = [];
            data.messages[chatId].push(systemMessage);
          }
          
          saveData();
          
          // Send to both users
          [user1, user2].forEach(userId => {
            const isCurrentUser = userId === currentUserId;
            sendToUser(userId, 'message_pinned', { 
              chatId, 
              pinnedMessages: data.pinnedMessages[userId]?.[chatId] || [],
              systemMessage: isCurrentUser && systemMessage ? systemMessage : null
            });
          });
          
          // Also send system message to the other user as a new_message event
          if (systemMessage && !isSavedMessages) {
            const otherUserId = user1 === currentUserId ? user2 : user1;
            sendToUser(otherUserId, 'new_message', {
              message: systemMessage,
              chats: data.chats[otherUserId] || {},
              senderId: currentUserId
            });
          }
          break;
        }
        
        case 'add_reaction': {
          const { chatId, messageId, oderId, emoji } = msgData;
          const oderId2 = oderId; // For compatibility
          
          if (data.messages[chatId]) {
            const msg = data.messages[chatId].find(m => m.id === messageId);
            if (msg) {
              if (!msg.reactions) msg.reactions = [];
              
              // Check if user already has this exact reaction (for toggle removal)
              const existingIndex = msg.reactions.findIndex(r => 
                (r.userId === oderId2 || r.oderId === oderId2) && r.emoji === emoji
              );
              
              if (existingIndex >= 0) {
                // Remove existing reaction (toggle off)
                msg.reactions.splice(existingIndex, 1);
              } else {
                // Remove any other reaction from this user first
                msg.reactions = msg.reactions.filter(r => 
                  r.userId !== oderId2 && r.oderId !== oderId2
                );
                // Add new reaction
                msg.reactions.push({ userId: oderId2, emoji });
              }
              
              saveData();
              
              const [user1, user2] = chatId.split(':');
              [user1, user2].forEach(userId => {
                sendToUser(userId, 'reaction_updated', { 
                  chatId, 
                  messageId, 
                  reactions: msg.reactions 
                });
              });
            }
          }
          break;
        }
        
        case 'heartbeat': {
          sendTo(ws, 'heartbeat_ack', { timestamp: Date.now() });
          break;
        }
        
        default:
          console.log('Unknown message type:', type);
      }
    } catch (e) {
      console.error('Error handling message:', e);
    }
  });
  
  ws.on('close', () => {
    if (currentUserId) {
      console.log(`👋 User disconnected: ${currentUserId}`);
      onlineUsers.delete(currentUserId);
      
      if (data.users[currentUserId]) {
        data.users[currentUserId].isOnline = false;
        data.users[currentUserId].lastSeen = Date.now();
        saveData();
      }
      
      broadcast({ 
        type: 'user_offline', 
        data: { 
          userId: currentUserId, 
          lastSeen: Date.now(),
          onlineUsers: getOnlineUserIds()
        } 
      });
    }
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

function getAllUserMessages(userId) {
  const userMessages = {};
  
  for (const chatId of Object.keys(data.messages)) {
    const [user1, user2] = chatId.split(':');
    if (user1 === userId || user2 === userId) {
      userMessages[chatId] = data.messages[chatId];
    }
  }
  
  return userMessages;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 Chat Server running on port', PORT);
  console.log('   Health check: /health');
  console.log('');
});
