import request from "supertest";
import { io as ioc } from "socket.io-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { app, httpServer, __testHooks } from "../server.js";

async function signupUser(suffix) {
  const username = `e2e${suffix}`;
  const res = await request(app)
    .post("/signup")
    .set("x-vz-device-id", `e2e-dev-${suffix}-${Date.now()}`)
    .send({
      username,
      password: "Test12345",
      email: `${username}@example.com`,
      region: "Zemgale",
    });
  expect(res.status).toBe(200);
  expect(typeof res.body?.token).toBe("string");
  return { username, token: res.body.token };
}

function connectClient(port, token) {
  return new Promise((resolve, reject) => {
    const socket = ioc(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      timeout: 10000,
    });
    const t = setTimeout(() => {
      socket.close();
      reject(new Error("socket connect timeout"));
    }, 12000);
    socket.once("connect", () => {
      clearTimeout(t);
      resolve(socket);
    });
    socket.once("connect_error", (err) => {
      clearTimeout(t);
      socket.close();
      reject(err || new Error("connect_error"));
    });
  });
}

function waitBoardMove(socket, gameId, pred, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      socket.off("board.move", onMove);
      reject(new Error("board.move wait timeout"));
    }, timeoutMs);
    function onMove(p) {
      if (p?.gameId !== gameId) return;
      if (pred(p)) {
        clearTimeout(to);
        socket.off("board.move", onMove);
        resolve(p);
      }
    }
    socket.on("board.move", onMove);
  });
}

function waitBoardEnd(socket, gameId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      socket.off("board.end", onEnd);
      reject(new Error("board.end wait timeout"));
    }, timeoutMs);
    function onEnd(p) {
      if (p?.gameId !== gameId) return;
      clearTimeout(to);
      socket.off("board.end", onEnd);
      resolve(p);
    }
    socket.on("board.end", onEnd);
  });
}

function boardIndex(players, username) {
  const u = String(username || "").toLowerCase();
  for (let i = 0; i < (players || []).length; i++) {
    if (String(players[i] || "").toLowerCase() === u) return i;
  }
  return -1;
}

describe("Board socket E2E", () => {
  let port;

  beforeAll(async () => {
    await new Promise((resolve, reject) => {
      httpServer.listen(0, "127.0.0.1", (err) =>
        err ? reject(err) : resolve()
      );
    });
    const addr = httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : null;
    expect(port).toBeTruthy();
  });

  afterEach(() => {
    __testHooks.resetBoardTimeoutsForTestOnly();
  });

  afterAll(async () => {
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it("PvP accepts draw agreement when accepter is not on move (FIDE-style)", async () => {
    const u1 = await signupUser(`w${Date.now()}`);
    const u2 = await signupUser(`b${Date.now()}`);

    const s1 = await connectClient(port, u1.token);
    const s2 = await connectClient(port, u2.token);

    const inviteId = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("invite timeout")), 10000);
      s2.once("board.invite", (p) => {
        clearTimeout(to);
        resolve(String(p?.inviteId || "").trim());
      });
      s1.emit("board.invite", { target: u2.username, type: "chess" });
    });
    expect(inviteId.length).toBeGreaterThan(4);

    const start = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("board.start timeout")), 10000);
      s1.once("board.start", (p) => {
        clearTimeout(to);
        resolve(p);
      });
      s2.emit("board.accept", {
        inviteId,
        from: u1.username,
        type: "chess",
      });
    });

    const gameId = start?.gameId;
    expect(typeof gameId).toBe("string");
    expect(start?.players?.[0]).toBe(u1.username);

    s1.emit("board.chessDrawOffer", { gameId });

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("chessDrawState timeout")), 8000);
      s2.once("board.chessDrawState", (payload) => {
        clearTimeout(to);
        const from = payload?.chessDrawState?.drawOfferFrom;
        if (String(from).toLowerCase() === u1.username.toLowerCase()) resolve();
        else reject(new Error("unexpected draw offer state"));
      });
    });

    s2.emit("board.chessDrawAccept", { gameId });

    await Promise.all([
      new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("board.end s1")), 8000);
        s1.once("board.end", (p) => {
          clearTimeout(to);
          expect(p?.reason).toBe("draw_agreement");
          resolve();
        });
      }),
      new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("board.end s2")), 8000);
        s2.once("board.end", (p) => {
          clearTimeout(to);
          expect(p?.reason).toBe("draw_agreement");
          resolve();
        });
      }),
    ]);

    s1.close();
    s2.close();
  });

  it("chessDrawDecline clears an active offer", async () => {
    const u1 = await signupUser(`wd${Date.now()}`);
    const u2 = await signupUser(`bd${Date.now()}`);

    const s1 = await connectClient(port, u1.token);
    const s2 = await connectClient(port, u2.token);

    const inviteId = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("invite timeout")), 10000);
      s2.once("board.invite", (p) => {
        clearTimeout(to);
        resolve(String(p?.inviteId || "").trim());
      });
      s1.emit("board.invite", { target: u2.username, type: "chess" });
    });

    const start = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("board.start timeout")), 10000);
      s1.once("board.start", (p) => {
        clearTimeout(to);
        resolve(p);
      });
      s2.emit("board.accept", {
        inviteId,
        from: u1.username,
        type: "chess",
      });
    });

    const gameId = start?.gameId;
    s1.emit("board.chessDrawOffer", { gameId });

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("wait offer")), 8000);
      s2.once("board.chessDrawState", (payload) => {
        clearTimeout(to);
        if (payload?.chessDrawState?.drawOfferFrom) resolve();
        else reject(new Error("expected offer"));
      });
    });

    s2.emit("board.chessDrawDecline", { gameId });

    const cleared = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("clear timeout")), 8000);
      s1.once("board.chessDrawState", (payload) => {
        clearTimeout(to);
        resolve(!payload?.chessDrawState?.drawOfferFrom);
      });
    });
    expect(cleared).toBe(true);

    s1.close();
    s2.close();
  });

  it("dambrete PvP: first legal move and board.move echo", async () => {
    const u1 = await signupUser(`dw${Date.now()}`);
    const u2 = await signupUser(`db${Date.now()}`);

    const s1 = await connectClient(port, u1.token);
    const s2 = await connectClient(port, u2.token);

    const inviteId = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("invite timeout")), 10000);
      s2.once("board.invite", (p) => {
        clearTimeout(to);
        resolve(String(p?.inviteId || "").trim());
      });
      s1.emit("board.invite", {
        target: u2.username,
        type: "dambrete",
        dambreteVariant: "russian",
      });
    });

    const start = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("board.start timeout")), 10000);
      s1.once("board.start", (p) => {
        clearTimeout(to);
        resolve(p);
      });
      s2.emit("board.accept", {
        inviteId,
        from: u1.username,
        type: "dambrete",
        dambreteVariant: "russian",
      });
    });

    const gameId = start.gameId;
    const movesRes = await request(app)
      .get(`/board/${gameId}/moves`)
      .set("Authorization", `Bearer ${u1.token}`);
    expect(movesRes.status).toBe(200);
    const body = movesRes.body || {};
    let move = null;
    if (Array.isArray(body.jumps) && body.jumps.length) {
      move = { jumps: body.jumps[0].jumps };
    } else if (Array.isArray(body.moves) && body.moves.length) {
      move = body.moves[0];
    }
    expect(move).toBeTruthy();

    const p2 = waitBoardMove(s2, gameId, (p) => p?.turn === 1);
    s1.emit("board.move", { gameId, move });
    const upd = await p2;
    expect(upd?.turn).toBe(1);

    s1.close();
    s2.close();
  });

  it("zole 2P PvP: bid big, discard, then resign ends with coins fields", async () => {
    const u1 = await signupUser(`zw${Date.now()}`);
    const u2 = await signupUser(`zb${Date.now()}`);

    const s1 = await connectClient(port, u1.token);
    const s2 = await connectClient(port, u2.token);

    const inviteId = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("invite timeout")), 10000);
      s2.once("board.invite", (p) => {
        clearTimeout(to);
        resolve(String(p?.inviteId || "").trim());
      });
      s1.emit("board.invite", {
        target: u2.username,
        type: "zole",
        zoleMode: "online_2p",
      });
    });

    const start = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("board.start timeout")), 15000);
      s1.once("board.start", (p) => {
        clearTimeout(to);
        resolve(p);
      });
      s2.emit("board.accept", {
        inviteId,
        from: u1.username,
        type: "zole",
        zoleMode: "online_2p",
      });
    });

    const gameId = start.gameId;
    const players = start.players;
    const i1 = boardIndex(players, u1.username);
    expect(i1).toBe(0);

    s1.emit("board.move", { gameId, bid: "big" });

    const afterBid = await waitBoardMove(s1, gameId, (p) => p?.zole?.phase === "discard");
    const hand = afterBid.zole?.myHand;
    expect(Array.isArray(hand)).toBe(true);
    expect(hand.length).toBeGreaterThanOrEqual(2);
    const c1 = hand[0];
    const c2 = hand[1];
    s1.emit("board.move", { gameId, discard: [c1, c2] });

    await waitBoardMove(s1, gameId, (p) => p?.zole?.phase === "play");

    const endP = waitBoardEnd(s1, gameId);
    s2.emit("board.resign", { gameId });
    const end = await endP;
    expect(end?.reason).toBe("resign");
    expect(end?.winner).toBe(u1.username);
    expect(typeof end?.coinsGain).toBe("number");
    expect(typeof end?.coinsLoss).toBe("number");

    s1.close();
    s2.close();
  });

  it("board invite timeout emits inviteTimedOut with inviteTimeoutMs", async () => {
    __testHooks.setBoardTimeoutsForTestOnly(800, 800);

    const u1 = await signupUser(`it${Date.now()}`);
    const u2 = await signupUser(`it2${Date.now()}`);

    const s1 = await connectClient(port, u1.token);
    const s2 = await connectClient(port, u2.token);

    s2.emit("board.invite", { target: u1.username, type: "chess" });

    const payload = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("timedOut event timeout")), 8000);
      s1.once("board.inviteTimedOut", (p) => {
        clearTimeout(to);
        resolve(p);
      });
      setTimeout(() => {
        __testHooks.processBoardIdleTimersForTestOnly();
      }, 950);
    });

    expect(payload?.inviteTimeoutMs).toBe(800);

    s1.close();
    s2.close();
  });
});
