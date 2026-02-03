export interface ClaudeResponse {
  content: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface ClaudeJsonOutput {
  result: string;
  session_id: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  total_cost_usd?: number;
}

const TIMEOUT_MS = 120_000; // 2 dakika

/**
 * Run Claude CLI with given args
 */
async function runClaude(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["claude", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error("Claude CLI timeout (2dk)"));
    }, TIMEOUT_MS);
  });

  const processPromise = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const [stdout, stderr, exitCode] = await Promise.race([processPromise, timeoutPromise]);
  return { stdout, stderr, exitCode };
}

/**
 * Parse Claude CLI JSON response
 */
function parseResponse(stdout: string, sessionId: string): ClaudeResponse {
  const response = JSON.parse(stdout) as ClaudeJsonOutput;
  return {
    content: response.result || "Yanıt alınamadı.",
    sessionId: response.session_id || sessionId,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    costUsd: response.total_cost_usd ?? 0,
  };
}

export async function chat(
  sessionId: string,
  message: string
): Promise<ClaudeResponse> {
  const baseArgs = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];

  // İlk deneme: --resume ile mevcut session'ı devam ettir
  const resumeArgs = [...baseArgs, "--resume", sessionId, message];
  const resumeResult = await runClaude(resumeArgs);

  if (resumeResult.exitCode === 0) {
    try {
      return parseResponse(resumeResult.stdout, sessionId);
    } catch {
      console.error("[Claude CLI] JSON parse hatası (resume):", resumeResult.stdout.slice(0, 300));
    }
  }

  // Session bulunamadı mı kontrol et
  const isSessionNotFound = resumeResult.stderr.includes("not found") ||
                            resumeResult.stderr.includes("does not exist") ||
                            resumeResult.stderr.includes("No conversation");

  if (isSessionNotFound) {
    console.log(`[Claude CLI] Session bulunamadı, yeni oluşturuluyor: ${sessionId.slice(0, 8)}...`);

    // İkinci deneme: --session-id ile yeni session oluştur
    const createArgs = [...baseArgs, "--session-id", sessionId, message];
    const createResult = await runClaude(createArgs);

    if (createResult.exitCode === 0) {
      try {
        return parseResponse(createResult.stdout, sessionId);
      } catch {
        console.error("[Claude CLI] JSON parse hatası (create):", createResult.stdout.slice(0, 300));
        throw new Error("Claude CLI yanıtı parse edilemedi");
      }
    }

    console.error("[Claude CLI] stderr (create):", createResult.stderr);
    throw new Error(`Claude CLI hata: exit ${createResult.exitCode}`);
  }

  // Başka bir hata
  console.error("[Claude CLI] stderr (resume):", resumeResult.stderr);
  throw new Error(`Claude CLI hata: exit ${resumeResult.exitCode}`);
}

/**
 * Tek kullanımlık session ile chat (analyzer için)
 */
export async function chatOneShot(message: string): Promise<string> {
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--output-format",
      "json",
      message,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error("Claude CLI timeout (2dk)"));
    }, TIMEOUT_MS);
  });

  const processPromise = (async () => {
    const [stdout, _, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`Claude CLI hata: exit ${exitCode}`);
    }

    return stdout;
  })();

  const stdout = await Promise.race([processPromise, timeoutPromise]);

  try {
    const response = JSON.parse(stdout) as ClaudeJsonOutput;
    return response.result || "";
  } catch {
    return stdout; // JSON değilse raw text dön
  }
}
