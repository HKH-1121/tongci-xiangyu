const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const MAX_ROUNDS = 5;
const WORD_PAIRS = [
  ["大海", "天空"], ["火锅", "冬天"], ["月亮", "夜晚"], ["考试", "学生"],
  ["冰块", "可乐"], ["猫咪", "纸箱"], ["森林", "雨后"], ["沙滩", "夏天"],
  ["咖啡", "早晨"], ["烟花", "新年"], ["图书馆", "安静"], ["星星", "宇宙"],
  ["牙刷", "早起"], ["奶茶", "珍珠"], ["篮球", "操场"], ["电影", "爆米花"],
  ["彩虹", "下雨"], ["枕头", "睡觉"], ["面包", "早餐"], ["风筝", "春天"],
  ["雪人", "围巾"], ["火车", "远方"], ["毕业", "青春"], ["音乐", "耳机"]
];

function cleanText(value, max = 16) {
  return String(value || "").replace(/[<>]/g, "").trim().slice(0, max);
}
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function normalizeAnswer(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]{}·…\-—_]/g, "");
}
function clearRoomTimers(room) {
  if (room.roundTimer) clearTimeout(room.roundTimer);
  if (room.autoStartTimer) clearTimeout(room.autoStartTimer);
  room.roundTimer = null;
  room.autoStartTimer = null;
}
function publicRoom(room) {
  const showAnswers = room.phase === "reveal" || room.phase === "over";
  return {
    code: room.code,
    maxPlayers: room.maxPlayers,
    roundSeconds: room.roundSeconds,
    phase: room.phase,
    round: room.roundIndex + 1,
    totalRounds: MAX_ROUNDS,
    prompt: room.prompt,
    deadline: room.deadline,
    hostId: room.hostId,
    players: room.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      score: p.score,
      submitted: Boolean(room.answers[p.id]),
      answer: showAnswers ? (room.answers[p.id] || "") : null
    })),
    results: showAnswers ? room.lastResults : null
  };
}
function broadcast(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}
function removePlayer(room, playerId) {
  room.players = room.players.filter((p) => p.id !== playerId);
  delete room.answers[playerId];
  if (room.hostId === playerId && room.players.length) room.hostId = room.players[0].id;
  if (!room.players.length) {
    clearRoomTimers(room);
    rooms.delete(room.code);
    return;
  }
  if (room.phase === "playing" && room.players.every((p) => room.answers[p.id])) revealRound(room);
  else broadcast(room);
}
function startRound(room) {
  if (!rooms.has(room.code) || room.players.length < 2) return;
  if (room.roundIndex >= MAX_ROUNDS) {
    room.phase = "over";
    room.deadline = null;
    broadcast(room);
    return;
  }
  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundIndex += 1;
  room.phase = "playing";
  room.prompt = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
  room.deadline = Date.now() + room.roundSeconds * 1000;
  room.answers = {};
  room.lastResults = null;
  broadcast(room);
  room.roundTimer = setTimeout(() => revealRound(room), room.roundSeconds * 1000);
}
function revealRound(room) {
  if (room.phase !== "playing") return;
  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = null;

  const groups = new Map();
  for (const player of room.players) {
    const answer = room.answers[player.id] || "";
    const key = normalizeAnswer(answer);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(player);
  }

  const matchCounts = new Map();
  for (const group of groups.values()) {
    if (group.length > 1) {
      for (const player of group) {
        const points = group.length - 1;
        player.score += points;
        matchCounts.set(player.id, {
          points,
          matchedWith: group.filter((p) => p.id !== player.id).map((p) => p.nickname)
        });
      }
    }
  }

  room.lastResults = room.players.map((p) => {
    const match = matchCounts.get(p.id);
    return {
      playerId: p.id,
      nickname: p.nickname,
      answer: room.answers[p.id] || "未作答",
      points: match ? match.points : 0,
      matchedWith: match ? match.matchedWith : [],
      score: p.score
    };
  });
  room.phase = "reveal";
  room.deadline = null;
  broadcast(room);
}
function startGame(room) {
  if (room.phase !== "lobby" || room.players.length !== room.maxPlayers) return;
  clearRoomTimers(room);
  room.roundIndex = 0;
  room.players.forEach((p) => { p.score = 0; });
  startRound(room);
}

io.on("connection", (socket) => {
  socket.on("room:create", (payload = {}) => {
    const nickname = cleanText(payload.nickname, 12);
    const maxPlayers = [2, 3, 4].includes(Number(payload.maxPlayers)) ? Number(payload.maxPlayers) : 2;
    const roundSeconds = Math.max(15, Math.min(120, Number(payload.roundSeconds) || 30));
    if (!nickname) return socket.emit("game:error", "先给自己起个昵称吧。");

    const code = makeCode();
    const player = { id: socket.id, nickname, score: 0 };
    const room = {
      code, maxPlayers, roundSeconds, phase: "lobby", hostId: socket.id,
      players: [player], roundIndex: 0, prompt: null, deadline: null,
      answers: {}, lastResults: null, roundTimer: null, autoStartTimer: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit("room:entered", { code });
    broadcast(room);
  });

  socket.on("room:join", (payload = {}) => {
    const code = cleanText(payload.code, 6).toUpperCase();
    const nickname = cleanText(payload.nickname, 12);
    const room = rooms.get(code);
    if (!nickname) return socket.emit("game:error", "先输入昵称再加入房间。");
    if (!room) return socket.emit("game:error", "没有找到这个房间，请检查房间号。");
    if (room.phase !== "lobby") return socket.emit("game:error", "这局游戏已经开始，暂时不能加入。");
    if (room.players.length >= room.maxPlayers) return socket.emit("game:error", "房间已经满员了。");
    room.players.push({ id: socket.id, nickname, score: 0 });
    socket.join(code);
    socket.emit("room:entered", { code });
    broadcast(room);

    if (room.players.length === room.maxPlayers) {
      room.autoStartTimer = setTimeout(() => startGame(room), 1800);
    }
  });

  socket.on("game:submit", (payload = {}) => {
    const code = cleanText(payload.code, 6).toUpperCase();
    const room = rooms.get(code);
    if (!room || room.phase !== "playing") return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || room.answers[socket.id]) return;
    const answer = cleanText(payload.answer, 20);
    if (!answer) return socket.emit("game:error", "写下你的联想词再提交吧。");
    room.answers[socket.id] = answer;
    if (room.players.every((p) => room.answers[p.id])) revealRound(room);
    else broadcast(room);
  });

  socket.on("game:next", (payload = {}) => {
    const code = cleanText(payload.code, 6).toUpperCase();
    const room = rooms.get(code);
    if (!room || room.phase !== "reveal" || room.hostId !== socket.id) return;
    if (room.roundIndex >= MAX_ROUNDS) {
      room.phase = "over";
      broadcast(room);
    } else {
      startRound(room);
    }
  });

  socket.on("room:leave", (payload = {}) => {
    const code = cleanText(payload.code, 6).toUpperCase();
    const room = rooms.get(code);
    if (!room) return;
    socket.leave(code);
    removePlayer(room, socket.id);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.players.some((p) => p.id === socket.id)) {
        removePlayer(room, socket.id);
        break;
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`同词相遇 is running on port ${PORT}`);
});
