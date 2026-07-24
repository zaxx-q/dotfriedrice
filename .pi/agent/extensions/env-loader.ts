import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const envVars: Record<string, string> = {};

  const parseEnv = (filePath: string) => {
    if (!filePath || !existsSync(filePath)) return;
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        
        const equalsIdx = trimmed.indexOf("=");
        if (equalsIdx === -1) continue;
        
        const key = trimmed.slice(0, equalsIdx).trim();
        let value = trimmed.slice(equalsIdx + 1).trim();
        
        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        
        envVars[key] = value;
      }
    } catch (err: any) {
      console.error(`[env-loader] Error reading ${filePath}:`, err.message);
    }
  };

  // 1. Load global .env (lowest priority)
  const globalDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
  const globalEnvPath = join(globalDir, ".env");
  parseEnv(globalEnvPath);

  // 2. Load project-local .env from process.cwd() (medium priority, overrides global)
  const processEnvPath = join(process.cwd(), ".env");
  parseEnv(processEnvPath);

  // 3. Apply to process.env only if not already defined (shell exports have highest priority)
  let loadedCount = 0;
  for (const [key, value] of Object.entries(envVars)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loadedCount++;
    }
  }

  // 4. Hook into session_start to dynamically load/reload from ctx.cwd if different
  pi.on("session_start", async (_event, ctx) => {
    let sessionLoadedCount = 0;
    const sessionEnvVars: Record<string, string> = {};

    const parseSessionEnv = (filePath: string) => {
      if (!filePath || !existsSync(filePath)) return;
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          
          const equalsIdx = trimmed.indexOf("=");
          if (equalsIdx === -1) continue;
          
          const key = trimmed.slice(0, equalsIdx).trim();
          let value = trimmed.slice(equalsIdx + 1).trim();
          
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          sessionEnvVars[key] = value;
        }
      } catch (err: any) {
        console.error(`[env-loader] Error reading ${filePath}:`, err.message);
      }
    };

    // Load from the active session's working directory
    if (ctx.cwd && ctx.cwd !== process.cwd()) {
      const sessionEnvPath = join(ctx.cwd, ".env");
      parseSessionEnv(sessionEnvPath);
    }

    // Apply any new variables found in session cwd env
    for (const [key, value] of Object.entries(sessionEnvVars)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        sessionLoadedCount++;
      }
    }

    const totalLoaded = loadedCount + sessionLoadedCount;
    if (totalLoaded > 0) {
      ctx.ui.notify(`[env-loader] Loaded ${totalLoaded} environment variables`, "info");
    }
  });
}
