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

export async function chat(
  _sessionId: string,
  message: string
): Promise<ClaudeResponse> {
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

  // Timeout için race condition
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error("Claude CLI timeout (2dk)"));
    }, TIMEOUT_MS);
  });

  const processPromise = (async () => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      console.error("[Claude CLI] stderr:", stderr);
      throw new Error(`Claude CLI hata: exit ${exitCode}`);
    }

    return stdout;
  })();

  const stdout = await Promise.race([processPromise, timeoutPromise]);

  try {
    const response = JSON.parse(stdout) as ClaudeJsonOutput;

    return {
      content: response.result || "Yanıt alınamadı.",
      sessionId: response.session_id || sessionId,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      costUsd: response.total_cost_usd ?? 0,
    };
  } catch (parseError) {
    console.error("[Claude CLI] JSON parse hatası, raw output:", stdout.slice(0, 500));
    throw new Error("Claude CLI yanıtı parse edilemedi");
  }
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
