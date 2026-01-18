/**
 * AI Provider module for World-Seed
 * 
 * Supports:
 * - Local: OpenAI-compatible endpoints (LM Studio, Ollama, etc.)
 * - Online: OpenAI, Gemini (future)
 * 
 * Security:
 * - All API keys/secrets stay in main process
 * - Renderer never sees credentials
 * - Logs never print keys
 */

import { net } from 'electron';

// ============================================================================
// Types
// ============================================================================

export type ProviderMode = 'local' | 'online';

export interface LocalProviderConfig {
    mode: 'local';
    baseUrl: string;  // e.g., http://localhost:1234/v1
    model: string;    // e.g., qwen2.5-coder
}

export interface OnlineProviderConfig {
    mode: 'online';
    provider: 'openai' | 'gemini';
    apiKey: string;   // NEVER logged or sent to renderer
    model: string;
}

export type ProviderConfig = LocalProviderConfig | OnlineProviderConfig;

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ChatOptions {
    temperature?: number;
    maxTokens?: number;
}

export interface ChatResponse {
    content: string;
    model: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

export interface TestConnectionResult {
    success: boolean;
    message: string;
    latencyMs: number;
    model?: string;
}

// ============================================================================
// Provider Implementation
// ============================================================================

/**
 * Make a chat completion request to an OpenAI-compatible endpoint
 */
async function chatOpenAICompatible(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
    apiKey?: string
): Promise<ChatResponse> {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 1024,
    });

    // Use Electron's net module for better security
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
        model: string;
        usage?: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
        };
    };

    return {
        content: data.choices[0]?.message?.content ?? '',
        model: data.model,
        usage: data.usage ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
        } : undefined,
    };
}

/**
 * Send a chat request using the configured provider
 */
export async function chat(
    config: ProviderConfig,
    messages: ChatMessage[],
    options: ChatOptions = {}
): Promise<ChatResponse> {
    if (config.mode === 'local') {
        return chatOpenAICompatible(config.baseUrl, config.model, messages, options);
    } else {
        // Online providers
        if (config.provider === 'openai') {
            return chatOpenAICompatible(
                'https://api.openai.com/v1',
                config.model,
                messages,
                options,
                config.apiKey
            );
        } else if (config.provider === 'gemini') {
            // TODO: Implement Gemini API (different format)
            throw new Error('Gemini provider not yet implemented');
        } else {
            throw new Error(`Unknown provider: ${(config as OnlineProviderConfig).provider}`);
        }
    }
}

/**
 * Test connection to an AI provider
 * Returns success status, message, and latency
 */
export async function testConnection(config: ProviderConfig): Promise<TestConnectionResult> {
    const startTime = Date.now();

    try {
        const response = await chat(config, [
            { role: 'user', content: 'Say "Hello" in exactly one word.' }
        ], {
            maxTokens: 10,
            temperature: 0,
        });

        const latencyMs = Date.now() - startTime;

        return {
            success: true,
            message: `Connected! Response: "${response.content.trim()}"`,
            latencyMs,
            model: response.model,
        };
    } catch (error) {
        const latencyMs = Date.now() - startTime;
        const message = error instanceof Error ? error.message : 'Unknown error';

        // Never log the full config (might contain API key)
        console.error('[ai] Test connection failed:', message);

        return {
            success: false,
            message: `Connection failed: ${message}`,
            latencyMs,
        };
    }
}

// ============================================================================
// Config Helpers (for safe logging)
// ============================================================================

/**
 * Get a safe version of config for logging (no secrets)
 */
export function getSafeConfigForLogging(config: ProviderConfig): Record<string, unknown> {
    if (config.mode === 'local') {
        return {
            mode: config.mode,
            baseUrl: config.baseUrl,
            model: config.model,
        };
    } else {
        return {
            mode: config.mode,
            provider: config.provider,
            model: config.model,
            apiKey: '[REDACTED]',
        };
    }
}

/**
 * Validate provider config
 */
export function validateConfig(config: ProviderConfig): { valid: boolean; error?: string } {
    if (config.mode === 'local') {
        if (!config.baseUrl) {
            return { valid: false, error: 'Base URL is required for local mode' };
        }
        if (!config.baseUrl.startsWith('http://') && !config.baseUrl.startsWith('https://')) {
            return { valid: false, error: 'Base URL must start with http:// or https://' };
        }
        if (!config.model) {
            return { valid: false, error: 'Model is required' };
        }
    } else {
        if (!config.apiKey) {
            return { valid: false, error: 'API key is required for online mode' };
        }
        if (!config.model) {
            return { valid: false, error: 'Model is required' };
        }
    }

    return { valid: true };
}
