const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data.json');

// Load data
let data = {
  users: {},
  messages: {},
  chats: {},
  groups: {},
  groupMessages: {},
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

if (!data.groups) data.groups = {};
if (!data.groupMessages) data.groupMessages = {};

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

// Get network IPs
function getNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
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
            groups: getUserGroups(id),
            messages: getAllUserMessages(id),
            groupMessages: getUserGroupMessages(id),
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
            groups: getUserGroups(userId),
            messages: getAllUserMessages(userId),
            groupMessages: getUserGroupMessages(userId),
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
            groups: getUserGroups(user.id),
            messages: getAllUserMessages(user.id),
            groupMessages: getUserGroupMessages(user.id),
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

        case 'create_group': {
          if (!currentUserId) return;

          const { id, name, description, avatar, memberIds = [] } = msgData;
          if (!name || !String(name).trim()) return;

          const uniqueMembers = Array.from(new Set([currentUserId, ...(memberIds || [])]))
            .filter(userId => data.users[userId] && !data.users[userId].isDeleted);

          const group = {
            id,
            name: String(name).trim(),
            description: description ? String(description).trim() : '',
            avatar: avatar || '👥',
            creatorId: currentUserId,
            memberIds: uniqueMembers,
            admins: [currentUserId],
            createdAt: Date.now(),
            isDeleted: false,
            unreadCounts: uniqueMembers.reduce((acc, userId) => {
              acc[userId] = 0;
              return acc;
            }, {})
          };

          data.groups[id] = group;
          if (!data.groupMessages[id]) data.groupMessages[id] = [];
          saveData();

          uniqueMembers.forEach(userId => {
            sendToUser(userId, 'group_created', { group });
          });
          break;
        }

        case 'send_group_message': {
          if (!currentUserId) return;

          const { id, groupId, senderId, text, replyTo, forwardedFrom } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) return;
          if (!group.memberIds.includes(currentUserId)) return;
          if (!text || !String(text).trim()) return;

          const message = {
            id,
            chatId: `group:${groupId}`,
            groupId,
            senderId,
            text: String(text).trim(),
            replyTo: replyTo || null,
            forwardedFrom: forwardedFrom || null,
            timestamp: Date.now(),
            status: 'sent',
            isEdited: false,
            isDeleted: false,
            reactions: [],
            seenBy: [senderId]
          };

          if (!data.groupMessages[groupId]) data.groupMessages[groupId] = [];
          data.groupMessages[groupId].push(message);

          group.lastMessage = message;
          if (!group.unreadCounts) group.unreadCounts = {};
          group.memberIds.forEach(userId => {
            if (userId !== senderId) {
              group.unreadCounts[userId] = (group.unreadCounts[userId] || 0) + 1;
            } else {
              group.unreadCounts[userId] = 0;
            }
          });

          saveData();

          sendToUser(senderId, 'group_message_sent', { groupId, message, group });
          group.memberIds
            .filter(userId => userId !== senderId)
            .forEach(userId => {
              sendToUser(userId, 'new_group_message', { groupId, message, group });
            });
          break;
        }

        case 'forward_group_message': {
          if (!currentUserId) return;
          const { id, groupId, senderId, text, forwardedFrom } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) return;
          if (!group.memberIds.includes(currentUserId)) return;
          if (!text || !String(text).trim()) return;

          const message = {
            id,
            chatId: `group:${groupId}`,
            groupId,
            senderId,
            text: String(text).trim(),
            replyTo: null,
            forwardedFrom: forwardedFrom || null,
            timestamp: Date.now(),
            status: 'sent',
            isEdited: false,
            isDeleted: false,
            reactions: [],
            seenBy: [senderId]
          };

          if (!data.groupMessages[groupId]) data.groupMessages[groupId] = [];
          data.groupMessages[groupId].push(message);

          group.lastMessage = message;
          if (!group.unreadCounts) group.unreadCounts = {};
          group.memberIds.forEach(userId => {
            if (userId !== senderId) {
              group.unreadCounts[userId] = (group.unreadCounts[userId] || 0) + 1;
            } else {
              group.unreadCounts[userId] = 0;
            }
          });

          saveData();

          sendToUser(senderId, 'group_message_sent', { groupId, message, group });
          group.memberIds
            .filter(userId => userId !== senderId)
            .forEach(userId => {
              sendToUser(userId, 'new_group_message', { groupId, message, group });
            });
          break;
        }

        case 'mark_group_seen': {
          if (!currentUserId) return;
          const { groupId, userId } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) return;
          if (!group.memberIds.includes(userId)) return;
          if (!data.groupMessages[groupId]) data.groupMessages[groupId] = [];
          if (!group.unreadCounts) group.unreadCounts = {};
          const msgs = data.groupMessages[groupId];
          const seenIds = [];
          msgs.forEach(m => {
            if (m.isSystem || m.senderId === userId) return;
            if (!Array.isArray(m.seenBy)) m.seenBy = [m.senderId].filter(Boolean);
            if (!m.seenBy.includes(userId)) {
              m.seenBy.push(userId);
              seenIds.push(m.id);
            }
          });
          group.unreadCounts[userId] = 0;
          saveData();
          sendToUser(userId, 'group_unread_updated', { group });
          if (seenIds.length > 0) {
            group.memberIds.forEach(memberId => {
              sendToUser(memberId, 'group_messages_seen', { groupId, userId, messageIds: seenIds });
            });
          }
          break;
        }

        case 'mark_group_messages_seen': {
          if (!currentUserId) return;
          const { groupId, userId, messageIds } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) return;
          if (userId !== currentUserId) return;
          if (!group.memberIds.includes(userId)) return;
          if (!Array.isArray(messageIds) || messageIds.length === 0) return;
          if (!data.groupMessages[groupId]) data.groupMessages[groupId] = [];
          if (!group.unreadCounts) group.unreadCounts = {};

          const targetIds = new Set(messageIds);
          const seenIds = [];
          for (const m of data.groupMessages[groupId]) {
            if (!targetIds.has(m.id)) continue;
            if (m.isSystem || m.senderId === userId) continue;
            if (!Array.isArray(m.seenBy)) m.seenBy = [m.senderId].filter(Boolean);
            if (!m.seenBy.includes(userId)) {
              m.seenBy.push(userId);
              seenIds.push(m.id);
            }
          }

          if (seenIds.length === 0) return;

          const currentUnread = group.unreadCounts[userId] || 0;
          group.unreadCounts[userId] = Math.max(0, currentUnread - seenIds.length);
          saveData();

          sendToUser(userId, 'group_unread_updated', { group });
          group.memberIds.forEach(memberId => {
            sendToUser(memberId, 'group_messages_seen', { groupId, userId, messageIds: seenIds });
          });
          break;
        }

        case 'edit_group_message': {
          if (!currentUserId) return;
          const { groupId, messageId, newText, userId } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) return;
          if (!group.memberIds.includes(userId)) return;
          const msgs = data.groupMessages[groupId] || [];
          const msg = msgs.find(m => m.id === messageId);
          if (!msg || msg.senderId !== userId) return;
          msg.text = String(newText || '').trim();
          msg.isEdited = true;
          saveData();
          group.memberIds.forEach(memberId => {
            sendToUser(memberId, 'group_message_edited', { groupId, messageId, newText: msg.text });
          });
          break;
        }

        case 'delete_group_message': {
          if (!currentUserId) return;
          const { groupId, messageIds, userId } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) return;
          if (!group.memberIds.includes(userId)) return;
          const ids = new Set(messageIds || []);
          const msgs = data.groupMessages[groupId] || [];
          const canDelete = new Set(
            msgs.filter(m => ids.has(m.id) && (m.senderId === userId || group.admins?.includes(userId))).map(m => m.id)
          );
          data.groupMessages[groupId] = msgs.filter(m => !canDelete.has(m.id));
          if (group.pinnedMessageIds) {
            group.pinnedMessageIds = group.pinnedMessageIds.filter(id => !canDelete.has(id));
          }
          saveData();
          group.memberIds.forEach(memberId => {
            sendToUser(memberId, 'group_message_deleted', { groupId, messageIds: Array.from(canDelete) });
          });
          break;
        }

        case 'pin_group_message': {
          if (!currentUserId) return;
          const { groupId, messageId, isPinned, userId } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) return;
          if (!group.memberIds.includes(userId)) return;
          if (!group.admins?.includes(userId) && group.creatorId !== userId) return;
          if (!group.pinnedMessageIds) group.pinnedMessageIds = [];
          if (isPinned) {
            if (!group.pinnedMessageIds.includes(messageId)) {
              group.pinnedMessageIds.push(messageId);
            }
          } else {
            group.pinnedMessageIds = group.pinnedMessageIds.filter(id => id !== messageId);
          }
          saveData();
          group.memberIds.forEach(memberId => {
            sendToUser(memberId, 'group_message_pinned', { group });
          });
          break;
        }

        case 'add_group_member': {
          if (!currentUserId) return;
          const { groupId, userId, actorId } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) return;
          if (actorId !== currentUserId) return;
          const canManage = group.creatorId === actorId || group.admins?.includes(actorId);
          if (!canManage) return;
          if (!data.users[userId] || data.users[userId].isDeleted) return;
          if (!group.memberIds.includes(userId)) {
            group.memberIds.push(userId);
          }
          if (!group.unreadCounts) group.unreadCounts = {};
          group.unreadCounts[userId] = group.unreadCounts[userId] || 0;
          saveData();
          group.memberIds.forEach(memberId => {
            sendToUser(memberId, 'group_updated', { group, groupId });
          });
          sendToUser(userId, 'group_updated', { group, groupId });
          break;
        }

        case 'remove_group_member': {
          if (!currentUserId) return;
          const { groupId, userId, actorId } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) return;
          if (actorId !== currentUserId) return;
          const canManage = group.creatorId === actorId || group.admins?.includes(actorId) || actorId === userId;
          if (!canManage) return;
          if (userId === group.creatorId) return;
          group.memberIds = (group.memberIds || []).filter(id => id !== userId);
          group.admins = (group.admins || []).filter(id => id !== userId);
          if (group.unreadCounts) delete group.unreadCounts[userId];
          saveData();
          group.memberIds.forEach(memberId => {
            sendToUser(memberId, 'group_updated', { group, groupId });
          });
          sendToUser(userId, 'group_updated', { group: null, groupId });
          break;
        }

        case 'set_group_admin': {
          if (!currentUserId) return;
          const { groupId, userId, isAdmin, actorId } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) return;
          if (actorId !== currentUserId) return;
          if (group.creatorId !== actorId) return;
          if (!group.memberIds.includes(userId)) return;
          if (!group.admins) group.admins = [group.creatorId];
          if (isAdmin) {
            if (!group.admins.includes(userId)) group.admins.push(userId);
          } else if (userId !== group.creatorId) {
            group.admins = group.admins.filter(id => id !== userId);
          }
          saveData();
          group.memberIds.forEach(memberId => {
            sendToUser(memberId, 'group_updated', { group, groupId });
          });
          break;
        }

        case 'add_group_reaction': {
          if (!currentUserId) return;
          const { groupId, messageId, userId, emoji } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) return;
          if (!group.memberIds.includes(userId)) return;
          const msgs = data.groupMessages[groupId] || [];
          const msg = msgs.find(m => m.id === messageId);
          if (!msg) return;
          if (!msg.reactions) msg.reactions = [];
          const existingIndex = msg.reactions.findIndex(r =>
            (r.userId === userId || r.oderId === userId) && r.emoji === emoji
          );
          if (existingIndex >= 0) {
            msg.reactions.splice(existingIndex, 1);
          } else {
            msg.reactions = msg.reactions.filter(r => r.userId !== userId && r.oderId !== userId);
            msg.reactions.push({ userId, emoji });
          }
          saveData();
          group.memberIds.forEach(memberId => {
            sendToUser(memberId, 'group_reaction_updated', {
              groupId,
              messageId,
              reactions: msg.reactions
            });
          });
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
        
        case 'forward_message': {
          if (!currentUserId) return;
          
          const { id, chatId, senderId, receiverId, text, forwardedFrom } = msgData;
          
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
            replyTo: null,
            timestamp: Date.now(),
            status: 'sent',
            isEdited: false,
            isDeleted: false,
            reactions: [],
            forwardedFrom: forwardedFrom || null
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

        case 'group_typing': {
          const { groupId, userId, isTyping } = msgData;
          const group = data.groups[groupId];
          if (!group || group.isDeleted) break;
          if (!group.memberIds.includes(userId)) break;
          group.memberIds
            .filter(memberId => memberId !== userId)
            .forEach(memberId => {
              sendToUser(memberId, 'group_user_typing', { groupId, userId, isTyping });
            });
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

function getUserGroups(userId) {
  const result = {};
  for (const [groupId, group] of Object.entries(data.groups || {})) {
    if (group.memberIds?.includes(userId) && !group.isDeleted) {
      result[groupId] = group;
    }
  }
  return result;
}

function getUserGroupMessages(userId) {
  const result = {};
  const groups = getUserGroups(userId);
  for (const groupId of Object.keys(groups)) {
    result[groupId] = data.groupMessages[groupId] || [];
  }
  return result;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = getNetworkIPs();
  
  console.log('\n🚀 Chat Server running on port', PORT);
  console.log('   Local:   ws://localhost:' + PORT);
  ips.forEach(ip => {
    console.log(`   Network: ws://${ip}:${PORT}`);
  });
  console.log('');
});
