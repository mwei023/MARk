import "dotenv/config";
import { retrieveContext } from "./rags";

(async () => {
  console.log("🔍 Testing retrieval for: 'favourite color'");
  console.log("🔍 DATABASE_URL set:", !!process.env.DATABASE_URL);
  
  // ✅ Positional args: query, limit, topic, threshold
  const results = await retrieveContext("favourite color", 3, undefined, 0.3);
  
  console.log("📦 Results:", results);
})();