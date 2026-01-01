import { httpServer, PORT, wheelSyncTokenSlots } from "./base.js";
import "./routes.js";
import "./sockets.js";

// ======== startup ========
wheelSyncTokenSlots(true);

httpServer.listen(PORT, () => {
  console.log(`VĀRDU ZONA serveris iet uz porta ${PORT}`);
});
