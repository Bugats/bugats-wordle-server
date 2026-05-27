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
      ageConfirmed: true,
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

/** Gaida pirmo `board.move`, kas atbilst `pred`, no jebkura socket saraksta. */
function waitBoardMoveFromAny(sockets, gameId, pred, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      for (const s of sockets) s.removeListener("board.move", onMove);
      reject(new Error("board.move (any) wait timeout"));
    }, timeoutMs);
    function onMove(p) {
      if (p?.gameId !== gameId) return;
      if (!pred(p)) return;
      clearTimeout(to);
      for (const s of sockets) s.removeListener("board.move", onMove);
      resolve(p);
    }
    for (const s of sockets) s.on("board.move", onMove);
  });
}

function waitZoleBidTurn(sockets, gameId, bidTurn, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      for (const s of sockets) s.removeListener("board.move", onMove);
      reject(new Error("waitZoleBidTurn timeout"));
    }, timeoutMs);
    function onMove(p) {
      if (p?.gameId !== gameId) return;
      if (p?.zole?.phase !== "bid") return;
      if (p.zole.bidTurn !== bidTurn) return;
      clearTimeout(to);
      for (const s of sockets) s.removeListener("board.move", onMove);
      resolve(p);
    }
    for (const s of sockets) s.on("board.move", onMove);
  });
}

function waitBoardEndFromAny(sockets, gameId, pred, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      for (const s of sockets) s.removeListener("board.end", onEnd);
      reject(new Error("board.end (any) wait timeout"));
    }, timeoutMs);
    function onEnd(p) {
      if (p?.gameId !== gameId) return;
      if (pred && !pred(p)) return;
      clearTimeout(to);
      for (const s of sockets) s.removeListener("board.end", onEnd);
      resolve(p);
    }
    for (const s of sockets) s.on("board.end", onEnd);
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
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }
    await new Promise((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }, 120000);

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

  it(
    "board invite timeout emits inviteTimedOut with inviteTimeoutMs",
    async () => {
      __testHooks.setBoardTimeoutsForTestOnly(800, 800);
      expect(__testHooks.getBoardGameInviteTimeoutMsForTestOnly()).toBe(800);

      const u1 = await signupUser(`it${Date.now()}`);
      const u2 = await signupUser(`it2${Date.now()}`);

      const s1 = await connectClient(port, u1.token);
      const s2 = await connectClient(port, u2.token);

      try {
        s2.emit("board.invite", { target: u1.username, type: "chess" });

        const payload = await new Promise((resolve, reject) => {
          const to = setTimeout(
            () => reject(new Error("timedOut event timeout")),
            10000
          );
          s1.once("board.inviteTimedOut", (p) => {
            clearTimeout(to);
            resolve(p);
          });
          setTimeout(() => __testHooks.expireBoardInvitesForTestOnly(), 50);
        });

        expect(payload?.inviteTimeoutMs).toBe(800);
        expect(payload?.rematch).toBeFalsy();
      } finally {
        s1.close();
        s2.close();
      }
    },
    20000
  );

  it("rematch timeout emits board.rematchTimedOut (not inviteTimedOut)", async () => {
    __testHooks.setBoardTimeoutsForTestOnly(800, 800);

    const u1 = await signupUser(`rm${Date.now()}`);
    const u2 = await signupUser(`rm2${Date.now()}`);

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

    const startRm = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("board.start s1")), 10000);
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
    const gid = startRm?.gameId;
    expect(typeof gid).toBe("string");

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("board.end s2 timeout")), 10000);
      s2.once("board.end", () => {
        clearTimeout(to);
        resolve();
      });
      s2.emit("board.resign", { gameId: gid });
    });

    let sawWrong = false;
    s1.once("board.inviteTimedOut", () => {
      sawWrong = true;
    });

    s1.emit("board.rematchRequest", {
      type: "chess",
      opponentUsername: u2.username,
    });

    const remPayload = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("rematchTimedOut timeout")), 8000);
      s1.once("board.rematchTimedOut", (p) => {
        clearTimeout(to);
        resolve(p);
      });
      setTimeout(() => __testHooks.expireBoardInvitesForTestOnly(), 50);
    });

    expect(sawWrong).toBe(false);
    expect(remPayload?.rematch).toBe(true);
    expect(remPayload?.inviteTimeoutMs).toBe(800);

    s1.close();
    s2.close();
  }, 60000);

  it(
    "chess PvP: resign awards coinsGain / coinsLoss on board.end",
    async () => {
      const u1 = await signupUser(`cr${Date.now()}`);
      const u2 = await signupUser(`cr2${Date.now()}`);

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
        const to = setTimeout(() => reject(new Error("board.start")), 10000);
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

      const gameId = start.gameId;
      const movesRes = await request(app)
        .get(`/board/${gameId}/moves`)
        .set("Authorization", `Bearer ${u1.token}`);
      expect(movesRes.status).toBe(200);
      const m0 = movesRes.body?.moves?.[0];
      expect(m0?.san).toBeTruthy();

      const afterMove = waitBoardMoveFromAny(
        [s1, s2],
        gameId,
        (p) => p?.turn === 1 && p?.fen
      );
      s1.emit("board.move", { gameId, san: m0.san });
      await afterMove;

      const endW = waitBoardEnd(s1, gameId);
      s2.emit("board.resign", { gameId });
      const end = await endW;
      expect(end?.reason).toBe("resign");
      expect(end?.winner).toBe(u1.username);
      expect(end?.coinsGain).toBe(8);
      expect(end?.coinsLoss).toBe(0);

      const endL = await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("loser board.end")), 8000);
        s2.once("board.end", (p) => {
          clearTimeout(to);
          resolve(p);
        });
      });
      expect(endL?.coinsGain).toBe(0);
      expect(endL?.coinsLoss).toBe(3);

      s1.close();
      s2.close();
    },
    45000
  );

  it(
    "chess PvP: fool's mate finish — checkmate on board.end",
    async () => {
      const u1 = await signupUser(`cmw${Date.now()}`);
      const u2 = await signupUser(`cmb${Date.now()}`);

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
        const to = setTimeout(() => reject(new Error("board.start")), 10000);
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

      const gameId = start.gameId;
      const fen =
        "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";
      expect(__testHooks.setChessFenForTestOnly(gameId, fen)).toBe(true);

      const endP = waitBoardEndFromAny(
        [s1, s2],
        gameId,
        (p) => p?.reason === "checkmate",
        20000
      );
      s2.emit("board.move", { gameId, san: "Qh4#" });
      const end = await endP;
      expect(end?.reason).toBe("checkmate");
      expect(String(end?.winner || "").toLowerCase()).toBe(
        u2.username.toLowerCase()
      );

      s1.close();
      s2.close();
    },
    45000
  );

  it(
    "zole 3P: lobby, third seat, stake on board.end after resign",
    async () => {
      const h = await signupUser(`z3h${Date.now()}`);
      const j1 = await signupUser(`z3a${Date.now()}`);
      const j2 = await signupUser(`z3b${Date.now()}`);

      const sh = await connectClient(port, h.token);
      const s1 = await connectClient(port, j1.token);
      const s2 = await connectClient(port, j2.token);

      const lobbyP = new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("board.zoleLobby")), 10000);
        sh.once("board.zoleLobby", (p) => {
          clearTimeout(to);
          resolve(p);
        });
      });
      sh.emit("board.zoleCreateLobby", { zole3pCoinsPerPoint: 2 });
      const lob0 = await lobbyP;
      const lobbyId = lob0?.lobbyId;
      expect(typeof lobbyId).toBe("string");

      s1.emit("board.zoleJoinOpenLobby", { lobbyId });

      const inviteId = await new Promise((resolve, reject) => {
        const to = setTimeout(
          () => reject(new Error("third board.invite")),
          10000
        );
        s2.once("board.invite", (p) => {
          clearTimeout(to);
          resolve(String(p?.inviteId || "").trim());
        });
        sh.emit("board.zoleInviteThird", { target: j2.username });
      });
      expect(inviteId.length).toBeGreaterThan(4);

      const startP = new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("board.start h")), 15000);
        sh.once("board.start", (p) => {
          clearTimeout(to);
          resolve(p);
        });
      });
      s2.emit("board.zoleAcceptThird", {
        inviteId,
        from: h.username,
        lobbyId,
      });
      const st = await startP;
      const gameId = st.gameId;
      const players = st.players;
      expect(players?.length).toBe(3);
      expect(st.zole3pCoinsPerPoint).toBe(2);

      const socks = { [h.username]: sh, [j1.username]: s1, [j2.username]: s2 };
      const allSocks = [sh, s1, s2];

      let bidTurn = st.zole?.bidTurn ?? 0;
      for (let step = 0; step < 6; step++) {
        if (step > 0) {
          await waitZoleBidTurn(allSocks, gameId, bidTurn);
        }
        socks[players[bidTurn]].emit("board.move", { gameId, bid: "pass" });
        if (step < 5) bidTurn = (bidTurn + 1) % 3;
      }

      await waitBoardMoveFromAny(
        allSocks,
        gameId,
        (p) => p?.zole?.phase === "play" && p?.zole?.contract === "galdins",
        25000
      );

      const endH = waitBoardEnd(sh, gameId);
      s2.emit("board.resign", { gameId });
      const end = await endH;
      expect(end?.reason).toBe("resign");
      expect(end?.zole3pCoinsPerPoint).toBe(2);
      expect(end?.winner).toBe(h.username);

      s1.close();
      s2.close();
      sh.close();
    },
    60000
  );

  it(
    "zole 3P: natural maza_zole hand end with stake on board.end (coins from table)",
    async () => {
      const h = await signupUser(`z3m${Date.now()}`);
      const j1 = await signupUser(`z3m1${Date.now()}`);
      const j2 = await signupUser(`z3m2${Date.now()}`);

      const sh = await connectClient(port, h.token);
      const s1 = await connectClient(port, j1.token);
      const s2 = await connectClient(port, j2.token);

      const lobbyP = new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("board.zoleLobby")), 10000);
        sh.once("board.zoleLobby", (p) => {
          clearTimeout(to);
          resolve(p);
        });
      });
      sh.emit("board.zoleCreateLobby", { zole3pCoinsPerPoint: 2 });
      const lob0 = await lobbyP;
      const lobbyId = lob0?.lobbyId;
      expect(typeof lobbyId).toBe("string");

      s1.emit("board.zoleJoinOpenLobby", { lobbyId });

      const inviteId = await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("third invite")), 10000);
        s2.once("board.invite", (p) => {
          clearTimeout(to);
          resolve(String(p?.inviteId || "").trim());
        });
        sh.emit("board.zoleInviteThird", { target: j2.username });
      });

      const startP = new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("board.start")), 15000);
        sh.once("board.start", (p) => {
          clearTimeout(to);
          resolve(p);
        });
      });
      s2.emit("board.zoleAcceptThird", {
        inviteId,
        from: h.username,
        lobbyId,
      });
      const st = await startP;
      const gameId = st.gameId;
      expect(st.zole3pCoinsPerPoint).toBe(2);

      const allSocks = [sh, s1, s2];

      let bidTurn = st.zole?.bidTurn ?? 0;
      for (let step = 0; step < 6; step++) {
        if (step > 0) {
          await waitZoleBidTurn(allSocks, gameId, bidTurn);
        }
        const sock =
          st.players[bidTurn] === h.username
            ? sh
            : st.players[bidTurn] === j1.username
              ? s1
              : s2;
        sock.emit("board.move", { gameId, bid: "pass" });
        if (step < 5) bidTurn = (bidTurn + 1) % 3;
      }

      await waitBoardMoveFromAny(
        allSocks,
        gameId,
        (p) => p?.zole?.phase === "play" && p?.zole?.contract === "galdins",
        25000
      );

      expect(
        __testHooks.forceZole3pMazaZoleOneTrickLoseTestOnly(gameId, h.username)
      ).toBe(true);

      const mv1 = __testHooks.zoleFirstLegalCardForTestOnly(gameId, h.username);
      const mv2 = __testHooks.zoleFirstLegalCardForTestOnly(gameId, j1.username);
      const mv3 = __testHooks.zoleFirstLegalCardForTestOnly(gameId, j2.username);
      expect(mv1).toBeTruthy();
      expect(mv2).toBeTruthy();
      expect(mv3).toBeTruthy();

      sh.emit("board.move", { gameId, card: mv1 });
      s1.emit("board.move", { gameId, card: mv2 });
      const endP = waitBoardEndFromAny(
        allSocks,
        gameId,
        (p) => p?.reason === "win" && p?.type === "zole",
        25000
      );
      s2.emit("board.move", { gameId, card: mv3 });
      const end = await endP;
      expect(end?.reason).toBe("win");
      expect(end?.zole3pCoinsPerPoint).toBe(2);
      expect(end?.zole?.phase).toBe("end");
      const td = end?.zole?.tableDelta;
      expect(Array.isArray(td)).toBe(true);
      expect(td[0]).toBe(-14);
      expect(td[1]).toBe(7);
      expect(td[2]).toBe(7);
      expect(typeof end?.coinsGain).toBe("number");
      expect(typeof end?.coinsLoss).toBe("number");

      s1.close();
      s2.close();
      sh.close();
    },
    90000
  );
});
