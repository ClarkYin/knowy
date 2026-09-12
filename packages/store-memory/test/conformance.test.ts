import { runStoreConformance } from "@knowy/core/testing";
import { MemoryObjectStore } from "../src/index.js";

runStoreConformance("MemoryObjectStore", async () => new MemoryObjectStore());
