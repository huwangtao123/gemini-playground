/**
 * @fileoverview Deno server implementation for Gemini Playground
 * 
 * This module provides a Deno-based server implementation that mirrors the
 * Cloudflare Workers functionality, handling HTTP requests, WebSocket connections,
 * and static file serving for the Gemini AI interface.
 * 
 * Key differences from Cloudflare Workers version:
 * - Uses Deno.serve() instead of Workers fetch handler
 * - Direct file system access for static assets
 * - Native Deno WebSocket upgrade handling
 * 
 * @author Gemini Playground
 * @version 1.0.0
 */

/**
 * Determines MIME content type based on file extension (TypeScript version)
 * 
 * Maps common file extensions to their corresponding MIME types for proper
 * HTTP response headers. Supports web assets including JavaScript, CSS, HTML,
 * JSON, and common image formats. TypeScript version with strict typing.
 * 
 * Time Complexity: O(1) - constant time hash map lookup
 * Space Complexity: O(1) - fixed size mapping object
 * 
 * Flow:
 * 1. Extract file extension from path with null safety
 * 2. Convert to lowercase for case-insensitive matching
 * 3. Look up MIME type in strongly-typed mapping
 * 4. Return specific type or default to 'text/plain'
 * 
 * @param path - File path including extension (e.g., 'script.js', '/css/style.css')
 * @returns MIME type string (e.g., 'application/javascript', 'text/css')
 * 
 * @example
 * ```typescript
 * getContentType('/js/main.js'); // Returns 'application/javascript'
 * getContentType('style.css'); // Returns 'text/css'
 * getContentType('unknown.xyz'); // Returns 'text/plain'
 * ```
 */
const getContentType = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const types: Record<string, string> = {
    'js': 'application/javascript',
    'css': 'text/css',
    'html': 'text/html',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif'
  };
  return types[ext] || 'text/plain';
};

/**
 * Handles WebSocket upgrade requests using Deno's native WebSocket API
 * 
 * Creates a bidirectional WebSocket proxy between the client and Google's Gemini API
 * using Deno's built-in WebSocket upgrade functionality. Implements message queuing
 * for handling messages received before the target connection is established.
 * 
 * Key features:
 * - Native Deno WebSocket upgrade handling
 * - Message queuing for race condition handling
 * - Bidirectional message forwarding
 * - Connection state management and error handling
 * - Simplified event handling with direct callbacks
 * 
 * Time Complexity: O(n) where n is number of queued messages during connection setup
 * Space Complexity: O(m) where m is total size of pending messages in queue
 * 
 * Flow:
 * 1. Upgrade incoming request to WebSocket using Deno.upgradeWebSocket
 * 2. Extract target URL path and query parameters
 * 3. Establish connection to Google's Generative Language API
 * 4. Set up bidirectional event handlers (onopen, onmessage, onclose, onerror)
 * 5. Handle message queuing during connection establishment
 * 6. Forward messages between client and API
 * 
 * @param req - HTTP request to upgrade to WebSocket
 * @returns Promise resolving to WebSocket upgrade response
 * 
 * @example
 * ```typescript
 * // Client initiates WebSocket connection
 * // GET /ws?key=API_KEY with headers: { Upgrade: 'websocket' }
 * // → Proxies to wss://generativelanguage.googleapis.com/ws?key=API_KEY
 * ```
 */
async function handleWebSocket(req: Request): Promise<Response> {
  const { socket: clientWs, response } = Deno.upgradeWebSocket(req);
  
  const url = new URL(req.url);
  const targetUrl = `wss://generativelanguage.googleapis.com${url.pathname}${url.search}`;
  
  console.log('Target URL:', targetUrl);
  
  const pendingMessages: string[] = [];
  const targetWs = new WebSocket(targetUrl);
  
  targetWs.onopen = () => {
    console.log('Connected to Gemini');
    pendingMessages.forEach(msg => targetWs.send(msg));
    pendingMessages.length = 0;
  };

  clientWs.onmessage = (event) => {
    console.log('Client message received');
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(event.data);
    } else {
      pendingMessages.push(event.data);
    }
  };

  targetWs.onmessage = (event) => {
    console.log('Gemini message received');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(event.data);
    }
  };

  clientWs.onclose = (event) => {
    console.log('Client connection closed');
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1000, event.reason);
    }
  };

  targetWs.onclose = (event) => {
    console.log('Gemini connection closed');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(event.code, event.reason);
    }
  };

  targetWs.onerror = (error) => {
    console.error('Gemini WebSocket error:', error);
  };

  return response;
}

/**
 * Handles API requests by proxying them through the worker.mjs module (Deno version)
 * 
 * Delegates API request processing to the specialized API proxy worker,
 * which handles OpenAI-compatible endpoints and forwards them to Google's Gemini API.
 * Provides error handling with TypeScript type safety for error objects.
 * 
 * Supported endpoints:
 * - /chat/completions - Chat completion requests
 * - /embeddings - Text embedding requests  
 * - /models - Available model listing
 * 
 * Time Complexity: O(1) - constant time module import and delegation
 * Space Complexity: O(1) - minimal memory for error handling
 * 
 * Flow:
 * 1. Dynamic import of API proxy worker module
 * 2. Delegate request processing to worker.default.fetch
 * 3. Handle errors with TypeScript type assertions
 * 4. Return processed response or typed error response
 * 
 * @param req - HTTP request object for API endpoint
 * @returns Promise resolving to processed API response or error response
 * 
 * @throws Returns Response with 500 status for module import or processing errors
 * 
 * @example
 * ```typescript
 * // POST /chat/completions
 * // → Imports ./api_proxy/worker.mjs and delegates processing
 * 
 * // GET /models 
 * // → Returns available Gemini models in OpenAI-compatible format
 * ```
 */
async function handleAPIRequest(req: Request): Promise<Response> {
  try {
    const worker = await import('./api_proxy/worker.mjs');
    return await worker.default.fetch(req);
  } catch (error) {
    console.error('API request error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStatus = (error as { status?: number }).status || 500;
    return new Response(errorMessage, {
      status: errorStatus,
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
      }
    });
  }
}

/**
 * Main request handler for Deno server implementation
 * 
 * Primary entry point that routes incoming requests to appropriate processors:
 * - WebSocket upgrade requests → handleWebSocket
 * - API endpoints (/chat/completions, /embeddings, /models) → handleAPIRequest  
 * - Static assets → direct file system serving
 * 
 * Key differences from Cloudflare Workers version:
 * - Uses Deno.readFile() for static asset serving
 * - Direct file system access instead of KV store
 * - Native Deno.cwd() for path resolution
 * 
 * Time Complexity: O(1) for routing, O(k) for file reads where k is file size
 * Space Complexity: O(k) where k is size of served static files
 * 
 * Flow:
 * 1. Parse incoming request URL
 * 2. Check for WebSocket upgrade header
 * 3. Route API endpoints to proxy handler
 * 4. Serve static files from file system
 * 5. Return 404 for unknown paths
 * 
 * @param req - Incoming HTTP request object
 * @returns Promise resolving to HTTP response object
 * 
 * @example
 * ```typescript
 * // WebSocket connection
 * // GET /ws with Upgrade: websocket header
 * 
 * // API request
 * // POST /chat/completions
 * 
 * // Static asset
 * // GET /css/style.css → reads from src/static/css/style.css
 * ```
 */
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  console.log('Request URL:', req.url);

  // WebSocket 处理
  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }

  if (url.pathname.endsWith("/chat/completions") ||
      url.pathname.endsWith("/embeddings") ||
      url.pathname.endsWith("/models")) {
    return handleAPIRequest(req);
  }

  // 静态文件处理
  try {
    let filePath = url.pathname;
    if (filePath === '/' || filePath === '/index.html') {
      filePath = '/index.html';
    }

    const fullPath = `${Deno.cwd()}/src/static${filePath}`;

    const file = await Deno.readFile(fullPath);
    const contentType = getContentType(filePath);

    return new Response(file, {
      headers: {
        'content-type': `${contentType};charset=UTF-8`,
      },
    });
  } catch (e) {
    console.error('Error details:', e);
    return new Response('Not Found', { 
      status: 404,
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
      }
    });
  }
}

/**
 * Start Deno HTTP server with the main request handler
 * 
 * Initializes the Deno server using the native Deno.serve() function,
 * which handles incoming HTTP requests and WebSocket upgrades.
 * 
 * The server will listen on the default port (typically 8000) unless
 * configured otherwise through Deno CLI arguments.
 * 
 * @example
 * ```bash
 * # Start server on default port
 * deno run --allow-net --allow-read src/deno_index.ts
 * 
 * # Start server on specific port
 * deno run --allow-net --allow-read src/deno_index.ts --port 3000
 * ```
 */
Deno.serve(handleRequest); 