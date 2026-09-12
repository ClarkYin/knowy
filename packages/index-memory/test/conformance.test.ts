import { runIndexConformance } from "@knowy/core/testing";
import { MemoryIndex } from "../src/index.js";

runIndexConformance("MemoryIndex", async () => {
  const index = new MemoryIndex();
  return {
    index,
    seed: (tenantId, records) => index.seed(tenantId, records),
    setHash: (id, hash) => index.setHash(id, hash),
    remove: (id) => index.remove(id),
    failFor: (ids) => index.failFor(ids),
  };
});
