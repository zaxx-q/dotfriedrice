/**
 * Resilient Retry Extension
 *
 * Improves the auto-retry experience for users with unstable servers/endpoints.
 *
 * When Pi's built-in retry limit is exhausted — OR when the built-in retry
 * skips an error entirely (e.g. quota-exceeded with a server-suggested retry
 * delay) — this extension steps in:
 *
 * 1. Shows a menu asking how many more rounds to retry
 * 2. Implements its own retry loop with exponential backoff + jitter
 * 3. Respects server-suggested retry delays ("Please retry in Xs")
 * 4. Displays a live countdown timer between attempts (Escape to cancel)
 * 5. Shows cumulative retry stats in the status bar
 * 6. Notifies on successful recovery with total attempt/time stats
 * 7. Categorizes errors with human-readable labels
 * 8. Strips retry noise from LLM context so retries stay clean
 *
 * Place in ~/.pi/agent/extensions/resilient-retry.ts
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, Key } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NUDGE_CUSTOM_TYPE = "__resilient_retry_nudge__";
const STATUS_KEY = "resilient-retry";
const MAX_BACKOFF_MS = 120_000;
const FIXED_COOLDOWN_MS = 7_000;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const RETRYABLE_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|temporarily.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay|quota exceeded/i;

const OVERFLOW_RE =
	/context.?length|token.?limit|too.?long|max.?context|context.?window|prompt.?too|maximum.?context/i;

/** Errors that are truly permanent — no amount of waiting will help. */
const PERMANENT_RE =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit|available balance|insufficient_quota|out of budget/i;

/** Signals from the server that it WANTS us to retry. Overrides everything. */
const SERVER_SAYS_RETRY_RE = /please retry|retry in \d/i;

/**
 * Extended retryable check — broader than Pi's built-in.
 *
 * Key difference: errors containing "quota exceeded" or "billing" are
 * retryable HERE when the server also says "Please retry in Xs",
 * because the quota rotates.  Pi's built-in blocks those unconditionally.
 */
function isExtendedRetryable(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	if (OVERFLOW_RE.test(errorMessage)) return false;

	// Server explicitly tells us to retry — always honour that
	if (SERVER_SAYS_RETRY_RE.test(errorMessage)) return true;

	// Truly permanent account-level limits (no retry hint from server)
	if (PERMANENT_RE.test(errorMessage)) return false;

	return RETRYABLE_RE.test(errorMessage);
}

/**
 * Parse a server-suggested retry delay from the error message.
 * Matches patterns like "retry in 49.667691686s" or "Please retry in 30s".
 */
function parseServerRetryDelay(errorMessage: string): number | undefined {
	const match = errorMessage.match(/retry in (\d+(?:\.\d+)?)s/i);
	if (match) {
		const seconds = parseFloat(match[1]);
		if (seconds > 0 && seconds < 600) {
			return Math.ceil(seconds * 1000);
		}
	}
	return undefined;
}

function categorizeError(msg: string): string {
	if (/quota exceeded/i.test(msg)) return "Quota Exceeded (rotating)";
	if (/overloaded/i.test(msg)) return "Server Overloaded";
	if (/rate.?limit|too many requests|429/i.test(msg)) return "Rate Limited";
	if (/500/i.test(msg)) return "Internal Server Error (500)";
	if (/502/i.test(msg)) return "Bad Gateway (502)";
	if (/503|service.?unavailable/i.test(msg)) return "Service Unavailable (503)";
	if (/temporarily.?unavailable/i.test(msg)) return "Temporarily Unavailable";
	if (/504/i.test(msg)) return "Gateway Timeout (504)";
	if (/timed? out|timeout/i.test(msg)) return "Request Timeout";
	if (/connection.?refused/i.test(msg)) return "Connection Refused";
	if (/connection.?lost|connection.?error|network.?error/i.test(msg)) return "Connection Lost";
	if (/websocket/i.test(msg)) return "WebSocket Error";
	if (/fetch failed/i.test(msg)) return "Fetch Failed";
	if (/ended without|stream ended/i.test(msg)) return "Premature Stream End";
	if (/retry delay/i.test(msg)) return "Retry Delay Exceeded";
	return "Transient Error";
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface RetryState {
	roundsRemaining: number;
	totalRounds: number;
	attempts: number;
	startTime: number;
	lastError: string;
	category: string;
	aborted: boolean;
	isUnlimited?: boolean;
	isFixedCooldown?: boolean;
}

// ---------------------------------------------------------------------------
// Countdown component
// ---------------------------------------------------------------------------

class CountdownComponent {
	private seconds: number;
	private initialSeconds: number;
	private theme: Theme;
	private label: string;
	private onDone: (cancelled: boolean) => void;
	private interval: ReturnType<typeof setInterval> | undefined;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private tui: { requestRender(): void };
	private resolved = false;

	constructor(
		delayMs: number,
		label: string,
		theme: Theme,
		tui: { requestRender(): void },
		onDone: (cancelled: boolean) => void,
	) {
		this.initialSeconds = Math.ceil(delayMs / 1000);
		this.seconds = this.initialSeconds;
		this.label = label;
		this.theme = theme;
		this.tui = tui;
		this.onDone = onDone;

		this.interval = setInterval(() => {
			this.seconds--;
			this.invalidate();
			this.tui.requestRender();
			if (this.seconds <= 0) {
				this.finish(false);
			}
		}, 1000);
	}

	private finish(cancelled: boolean) {
		if (this.resolved) return;
		this.resolved = true;
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
		this.onDone(cancelled);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish(true);
		} else if (
			matchesKey(data, Key.enter) ||
			matchesKey(data, "return") ||
			matchesKey(data, "space")
		) {
			this.finish(false);
		} else if (matchesKey(data, Key.ctrl("right")) || matchesKey(data, Key.ctrl("up"))) {
			this.seconds += 30;
			this.initialSeconds = Math.max(this.initialSeconds, this.seconds);
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.ctrl("left")) || matchesKey(data, Key.ctrl("down"))) {
			this.seconds = Math.max(1, this.seconds - 30);
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.right) || matchesKey(data, Key.up)) {
			this.seconds += 5;
			this.initialSeconds = Math.max(this.initialSeconds, this.seconds);
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.down)) {
			this.seconds = Math.max(1, this.seconds - 5);
			this.invalidate();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const bar = th.fg("borderMuted", "─".repeat(width));
		const lines: string[] = [];
		lines.push("");
		lines.push(bar);
		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("warning", "⟳")} ${th.fg("text", this.label)}`, width));
		lines.push("");

		const barWidth = Math.max(10, width - 6);
		const ratio = this.initialSeconds > 0 ? this.seconds / this.initialSeconds : 0;
		const filled = Math.max(0, Math.min(barWidth, Math.round(ratio * barWidth)));
		const empty = barWidth - filled;
		const progressBar =
			th.fg("warning", "█".repeat(filled)) + th.fg("dim", "░".repeat(empty));
		lines.push(truncateToWidth(`  ${progressBar}`, width));
		lines.push("");

		const countdownText = `  Retrying in ${th.fg("accent", String(this.seconds))}s...    ${th.fg("dim", "Space/Enter skip  •  ←/→ adjust (Ctrl fast)  •  Esc cancel")}`;
		lines.push(truncateToWidth(countdownText, width));
		lines.push("");
		lines.push(bar);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let state: RetryState | undefined;
	let builtinAttempts = 0;
	let builtinRetryEngaged = false; // did built-in retry activate for THIS agent cycle?
	let gaveUp = false;

	// ------------------------------------------------------------------
	// Strip nudge messages from LLM context so retries stay clean
	// ------------------------------------------------------------------
	pi.on("context", async (event) => {
		const filtered = event.messages.filter((m: any) => {
			if (m.role === "custom" && m.customType === NUDGE_CUSTOM_TYPE) return false;
			return true;
		});

		if (state && !state.aborted && filtered.length > 0) {
			const last = filtered[filtered.length - 1];
			if (
				last &&
				(last as any).role === "assistant" &&
				(last as any).stopReason === "error"
			) {
				filtered.pop();
			}
		}

		if (filtered.length !== event.messages.length) {
			return { messages: filtered };
		}
	});

	// ------------------------------------------------------------------
	// Hide nudge messages from the TUI
	// ------------------------------------------------------------------
	pi.registerMessageRenderer(NUDGE_CUSTOM_TYPE, (_message, _options, _theme) => {
		return new Text("", 0, 0);
	});

	// ------------------------------------------------------------------
	// Track whether built-in retry engaged for the current agent cycle
	// ------------------------------------------------------------------
	(pi as any).on("auto_retry_start", (_event: any) => {
		builtinRetryEngaged = true;
		builtinAttempts++;
	});

	// ------------------------------------------------------------------
	// PATH A: Built-in retry exhausted (auto_retry_end with success=false)
	//
	// This fires exactly once after the full built-in cycle finishes.
	// ------------------------------------------------------------------
	(pi as any).on("auto_retry_end", async (event: any, ctx: ExtensionContext) => {
		if (event.success) {
			if (state && !state.aborted) {
				const elapsed = Date.now() - state.startTime;
				const totalAttempts = builtinAttempts + state.attempts;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(
					`✓ Recovered after ${totalAttempts} attempts (${formatDuration(elapsed)})`,
					"info",
				);
				state = undefined;
			}
			builtinAttempts = 0;
			return;
		}

		if (gaveUp) return;

		const errorMessage: string = event.finalError ?? "Unknown error";
		if (!isExtendedRetryable(errorMessage)) return;

		await handleRetryableFailure(errorMessage, ctx);
	});

	// ------------------------------------------------------------------
	// PATH B: Built-in retry SKIPPED the error entirely
	//
	// This catches errors that _isRetryableError rejected (e.g. quota
	// exceeded with a server retry hint).  We only act here when
	// builtinRetryEngaged is false — meaning auto_retry_start never
	// fired, so auto_retry_end won't fire either.
	// ------------------------------------------------------------------
	pi.on("agent_end", async (event, ctx) => {
		const ev = event as any;

		// Built-in retry will continue — let it work
		if (ev.willRetry === true) return;

		// Find the last assistant message
		let lastAssistant: any;
		for (let i = ev.messages.length - 1; i >= 0; i--) {
			if (ev.messages[i].role === "assistant") {
				lastAssistant = ev.messages[i];
				break;
			}
		}

		// --- Successful recovery during extended retry (first-attempt win) ---
		if (state && !state.aborted && lastAssistant && lastAssistant.stopReason !== "error") {
			const elapsed = Date.now() - state.startTime;
			const totalAttempts = builtinAttempts + state.attempts;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.notify(
				`✓ Recovered after ${totalAttempts} attempts (${formatDuration(elapsed)})`,
				"info",
			);
			state = undefined;
			builtinAttempts = 0;
			return;
		}

		// --- Built-in retry handled this cycle — defer to auto_retry_end ---
		if (builtinRetryEngaged) return;

		// --- Not an error, or gave up already ---
		if (gaveUp) return;
		if (!lastAssistant || lastAssistant.stopReason !== "error") return;

		const errorMessage: string = lastAssistant.errorMessage ?? "Unknown error";
		if (!isExtendedRetryable(errorMessage)) return;

		// Built-in retry skipped this error — we handle it ourselves
		await handleRetryableFailure(errorMessage, ctx);
	});

	// ------------------------------------------------------------------
	// Shared handler for both paths
	// ------------------------------------------------------------------
	async function handleRetryableFailure(
		errorMessage: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const category = categorizeError(errorMessage);

		// --- Extended retry in progress — continue the loop ---
		if (state && !state.aborted) {
			state.attempts++;
			state.lastError = errorMessage;
			state.category = category;

			if (!state.isUnlimited && state.roundsRemaining <= 0) {
				const elapsed = Date.now() - state.startTime;
				const totalAttempts = builtinAttempts + state.attempts;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(
					`✗ Extended retry gave up after ${totalAttempts} attempts (${formatDuration(elapsed)}) — ${category}`,
					"error",
				);
				state = undefined;
				builtinAttempts = 0;
				return;
			}

			if (!state.isUnlimited) {
				state.roundsRemaining--;
			}
			await waitAndRetry(state, errorMessage, ctx);
			return;
		}

		// --- First time — offer the menu ---
		builtinAttempts++;
		const initialAttempts = builtinAttempts;

		const choice = await showRetryMenu(category, errorMessage, ctx);

		if (choice === undefined || choice === 0) {
			gaveUp = true;
			builtinAttempts = 0;
			return;
		}

		const isUnlimited = choice === -1 || choice === -2;
		const isFixedCooldown = choice === -2;

		state = {
			roundsRemaining: isUnlimited ? 999999 : choice - 1,
			totalRounds: isUnlimited ? 999999 : choice,
			attempts: 1,
			startTime: Date.now(),
			lastError: errorMessage,
			category,
			aborted: false,
			isUnlimited,
			isFixedCooldown,
		};
		builtinAttempts = initialAttempts;

		await waitAndRetry(state, errorMessage, ctx);
	}

	// ------------------------------------------------------------------
	// Reset per agent cycle
	// ------------------------------------------------------------------
	pi.on("agent_start", async () => {
		builtinRetryEngaged = false;
		if (!state) {
			builtinAttempts = 0;
			gaveUp = false;
		}
	});

	// ------------------------------------------------------------------
	// Cleanup on session switch / shutdown
	// ------------------------------------------------------------------
	pi.on("session_shutdown", async (_event, ctx) => {
		if (state) {
			state.aborted = true;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			state = undefined;
		}
		builtinAttempts = 0;
		builtinRetryEngaged = false;
		gaveUp = false;
	});

	// ------------------------------------------------------------------
	// /retry-status command
	// ------------------------------------------------------------------
	pi.registerCommand("retry-status", {
		description: "Show current extended retry status",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("No extended retry in progress", "info");
				return;
			}
			const elapsed = formatDuration(Date.now() - state.startTime);
			const total = builtinAttempts + state.attempts;
			ctx.ui.notify(
				`Extended retry: ${state.attempts}/${state.totalRounds} rounds, ${total} total attempts, ${elapsed} elapsed — ${state.category}`,
				"info",
			);
		},
	});

	// ------------------------------------------------------------------
	// Retry menu
	// ------------------------------------------------------------------
	async function showRetryMenu(
		category: string,
		errorMessage: string,
		ctx: ExtensionContext,
	): Promise<number | undefined> {
		if (!ctx.hasUI) return undefined;

		const shortErr =
			errorMessage.length > 80
				? errorMessage.slice(0, 77) + "..."
				: errorMessage;

		// Check if server suggested a delay — show it in the menu
		const serverDelay = parseServerRetryDelay(errorMessage);
		const delayHint = serverDelay
			? `  Server suggests waiting ${Math.ceil(serverDelay / 1000)}s between attempts.`
			: "";

		const options = [
			`Retry 3 more rounds   (~12 attempts)`,
			`Retry 5 more rounds   (~20 attempts)`,
			`Retry 10 more rounds  (~40 attempts)`,
			`Retry 25 more rounds  (~100 attempts)`,
			`Retry unlimited rounds (exponential backoff)`,
			`Retry unlimited rounds (fixed 7s cooldown)`,
			`Give up`,
		];
		const values = [3, 5, 10, 25, -1, -2, 0];

		const result = await ctx.ui.custom<number | undefined>(
			(tui, theme, _kb, done) => {
				const items = options.map((label, i) => ({
					value: String(values[i]),
					label,
				}));

				let selected = 0;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;

				return {
					handleInput(data: string) {
						if (matchesKey(data, Key.up) && selected > 0) {
							selected--;
							cachedWidth = undefined;
							tui.requestRender();
						} else if (matchesKey(data, Key.down) && selected < items.length - 1) {
							selected++;
							cachedWidth = undefined;
							tui.requestRender();
						} else if (matchesKey(data, Key.enter)) {
							done(values[selected]);
						} else if (matchesKey(data, Key.escape)) {
							done(undefined);
						}
					},

					render(width: number): string[] {
						if (cachedLines && cachedWidth === width) return cachedLines;

						const th = theme;
						const bar = th.fg("borderMuted", "─".repeat(width));
						const lines: string[] = [];

						lines.push("");
						lines.push(bar);
						lines.push("");
						lines.push(
							truncateToWidth(
								`  ${th.fg("error", "✗")} ${th.fg("text", th.bold("Retries exhausted"))}`,
								width,
							),
						);
						lines.push(
							truncateToWidth(
								`  ${th.fg("warning", category)} ${th.fg("dim", "— " + shortErr)}`,
								width,
							),
						);
						if (delayHint) {
							lines.push(
								truncateToWidth(
									`  ${th.fg("muted", delayHint)}`,
									width,
								),
							);
						}
						lines.push("");
						lines.push(
							truncateToWidth(
								`  ${th.fg("text", "Continue retrying?")}`,
								width,
							),
						);
						lines.push("");

						for (let i = 0; i < items.length; i++) {
							const prefix = i === selected ? th.fg("accent", "❯ ") : "  ";
							const label =
								i === selected
									? th.fg("accent", items[i].label)
									: th.fg("text", items[i].label);
							lines.push(truncateToWidth(`  ${prefix}${label}`, width));
						}

						lines.push("");
						lines.push(
							truncateToWidth(
								`  ${th.fg("dim", "↑↓ navigate  •  Enter select  •  Esc give up")}`,
								width,
							),
						);
						lines.push("");
						lines.push(bar);

						cachedWidth = width;
						cachedLines = lines;
						return lines;
					},

					invalidate() {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				};
			},
		);

		return result;
	}

	// ------------------------------------------------------------------
	// Wait with countdown then fire a retry nudge
	// ------------------------------------------------------------------
	async function waitAndRetry(
		st: RetryState,
		errorMessage: string,
		ctx: ExtensionContext,
	): Promise<void> {
		let delayMs = FIXED_COOLDOWN_MS;
		if (!st.isFixedCooldown) {
			// Exponential backoff with jitter, capped
			const roundIndex = st.isUnlimited ? (st.attempts - 1) : (st.totalRounds - st.roundsRemaining - 1);
			const base = 3000;
			const raw = base * 2 ** Math.min(roundIndex, 5);
			const jitter = Math.random() * 0.3 * raw;
			delayMs = Math.min(raw + jitter, MAX_BACKOFF_MS);
		}

		// If the server told us how long to wait, respect that
		const serverDelay = parseServerRetryDelay(errorMessage);
		if (serverDelay) {
			// Use the larger of our backoff and the server's suggestion,
			// plus a small buffer so we don't hit the boundary exactly
			delayMs = Math.max(delayMs, serverDelay + 2000);
			delayMs = Math.min(delayMs, MAX_BACKOFF_MS);
		}

		const elapsed = formatDuration(Date.now() - st.startTime);
		const roundLabel = st.isUnlimited
			? `round ${st.attempts} (unlimited)`
			: `round ${st.totalRounds - st.roundsRemaining}/${st.totalRounds}`;

		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg(
				"warning",
				`⟳ Extended retry ${roundLabel}  •  ${elapsed}  •  ${st.category}`,
			),
		);

		if (!ctx.hasUI) {
			await new Promise((r) => setTimeout(r, delayMs));
		} else {
			const cancelled = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
				return new CountdownComponent(
					delayMs,
					`Extended retry ${roundLabel} — ${theme.fg("warning", st.category)}`,
					theme,
					tui,
					done,
				);
			});

			if (cancelled) {
				st.aborted = true;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				const totalAttempts = builtinAttempts + st.attempts;
				ctx.ui.notify(
					`Retry cancelled after ${totalAttempts} attempts (${formatDuration(Date.now() - st.startTime)})`,
					"info",
				);
				state = undefined;
				builtinAttempts = 0;
				return;
			}
		}

		pi.sendMessage(
			{
				customType: NUDGE_CUSTOM_TYPE,
				content: "",
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}
}
