/**
 * @fileoverview Cloudflare Workers main handler for Gemini Playground
 * 
 * This module serves as the primary entry point for the Cloudflare Workers runtime,
 * handling HTTP requests, WebSocket connections, and API proxying for the Gemini AI interface.
 * 
 * Key responsibilities:
 * - WebSocket proxy to Google's Generative Language API
 * - Static asset serving
 * - API request proxying
 * - Content type detection and handling
 * 
 * @author Gemini Playground
 * @version 1.0.0
 */

/**
 * Asset manifest for static content serving
 * Currently empty but can be populated with static asset mappings
 * @type {Object.<string, string>}
 */
const assetManifest = {};

/**
 * Cloudflare Workers default export handler
 * 
 * Main request handler that routes incoming requests to appropriate processors:
 * - WebSocket upgrade requests → handleWebSocket
 * - API endpoints (/chat/completions, /embeddings, /models) → handleAPIRequest  
 * - Static assets → direct serving from __STATIC_CONTENT
 * 
 * @type {Object}
 */
export default {
  /**
   * Primary fetch handler for all incoming requests
   * 
   * Routes requests based on headers and URL patterns:
   * 1. WebSocket upgrade requests are handled by handleWebSocket
   * 2. API endpoints are proxied through handleAPIRequest
   * 3. Static assets are served directly from Cloudflare's KV store
   * 4. All other requests return 404
   * 
   * Time Complexity: O(1) - constant time routing based on header/URL checks
   * Space Complexity: O(1) - minimal memory usage for URL parsing
   * 
   * @async
   * @param {Request} request - Incoming HTTP request object
   * @param {Object} env - Cloudflare Workers environment bindings
   * @param {Object} ctx - Execution context for request handling
   * @returns {Promise<Response>} HTTP response object
   * 
   * @example
   * // WebSocket connection
   * // GET /ws with Upgrade: websocket header
   * 
   * @example
   * // API request
   * // POST /chat/completions
   * 
   * @example
   * // Static asset
   * // GET /css/style.css
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 处理 WebSocket 连接
    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocket(request, env);
    }
    
    // 添加 API 请求处理
    if (url.pathname.endsWith("/chat/completions") ||
        url.pathname.endsWith("/embeddings") ||
        url.pathname.endsWith("/models")) {
      return handleAPIRequest(request, env);
    }

    // 处理静态资源
    if (url.pathname === '/' || url.pathname === '/index.html') {
      console.log('Serving index.html',env);
      return new Response(await env.__STATIC_CONTENT.get('index.html'), {
        headers: {
          'content-type': 'text/html;charset=UTF-8',
        },
      });
    }

    // 处理其他静态资源
    const asset = await env.__STATIC_CONTENT.get(url.pathname.slice(1));
    if (asset) {
      const contentType = getContentType(url.pathname);
      return new Response(asset, {
        headers: {
          'content-type': contentType,
        },
      });
    }



    return new Response('Not found', { status: 404 });
  },
};

/**
 * Determines MIME content type based on file extension
 * 
 * Maps common file extensions to their corresponding MIME types for proper
 * HTTP response headers. Supports web assets including JavaScript, CSS, HTML,
 * JSON, and common image formats.
 * 
 * Time Complexity: O(1) - constant time hash map lookup
 * Space Complexity: O(1) - fixed size mapping object
 * 
 * Flow:
 * 1. Extract file extension from path
 * 2. Convert to lowercase for case-insensitive matching
 * 3. Look up MIME type in predefined mapping
 * 4. Return specific type or default to 'text/plain'
 * 
 * @param {string} path - File path including extension (e.g., 'script.js', '/css/style.css')
 * @returns {string} MIME type string (e.g., 'application/javascript', 'text/css')
 * 
 * @example
 * getContentType('/js/main.js'); // Returns 'application/javascript'
 * getContentType('style.css'); // Returns 'text/css'
 * getContentType('unknown.xyz'); // Returns 'text/plain'
 */
function getContentType(path) {
  const ext = path.split('.').pop().toLowerCase();
  const types = {
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
}

/**
 * Handles WebSocket upgrade requests and establishes proxy connection to Google's Gemini API
 * 
 * Creates a bidirectional WebSocket proxy between the client and Google's Generative Language API.
 * Implements message queuing for handling messages received before the target connection is established.
 * 
 * Key features:
 * - WebSocket pair creation for client-server communication
 * - Message queuing for race condition handling
 * - Bidirectional message forwarding
 * - Connection state management and error handling
 * - Comprehensive logging for debugging
 * 
 * Time Complexity: O(n) where n is number of queued messages during connection setup
 * Space Complexity: O(m) where m is total size of pending messages in queue
 * 
 * Flow:
 * 1. Validate WebSocket upgrade request
 * 2. Extract target URL path and query parameters
 * 3. Create WebSocket pair (client ↔ proxy)
 * 4. Establish connection to Google's API
 * 5. Set up bidirectional event listeners
 * 6. Handle message queuing during connection establishment
 * 7. Forward messages between client and API
 * 
 * @async
 * @param {Request} request - HTTP request with WebSocket upgrade headers
 * @param {Object} env - Cloudflare Workers environment (unused in current implementation)
 * @returns {Promise<Response>} WebSocket response with 101 status code
 * 
 * @throws {Response} Returns 400 status if request is not a valid WebSocket upgrade
 * 
 * @example
 * // Client initiates WebSocket connection
 * // GET /ws?key=API_KEY with headers: { Upgrade: 'websocket' }
 * // → Proxies to wss://generativelanguage.googleapis.com/ws?key=API_KEY
 */
async function handleWebSocket(request, env) {


  if (request.headers.get("Upgrade") !== "websocket") {
		return new Response("Expected WebSocket connection", { status: 400 });
	}
  
	const url = new URL(request.url);
	const pathAndQuery = url.pathname + url.search;
	const targetUrl = `wss://generativelanguage.googleapis.com${pathAndQuery}`;
	  
	console.log('Target URL:', targetUrl);
  
  const [client, proxy] = new WebSocketPair();
  proxy.accept();
  
   // 用于存储在连接建立前收到的消息
   let pendingMessages = [];
  
   const targetWebSocket = new WebSocket(targetUrl);
 
   console.log('Initial targetWebSocket readyState:', targetWebSocket.readyState);
 
   targetWebSocket.addEventListener("open", () => {
     console.log('Connected to target server');
     console.log('targetWebSocket readyState after open:', targetWebSocket.readyState);
     
     // 连接建立后，发送所有待处理的消息
     console.log(`Processing ${pendingMessages.length} pending messages`);
     for (const message of pendingMessages) {
      try {
        targetWebSocket.send(message);
        console.log('Sent pending message:', message);
      } catch (error) {
        console.error('Error sending pending message:', error);
      }
     }
     pendingMessages = []; // 清空待处理消息队列
   });
 
   proxy.addEventListener("message", async (event) => {
     console.log('Received message from client:', {
       dataPreview: typeof event.data === 'string' ? event.data.slice(0, 200) : 'Binary data',
       dataType: typeof event.data,
       timestamp: new Date().toISOString()
     });
     
     console.log("targetWebSocket.readyState"+targetWebSocket.readyState)
     if (targetWebSocket.readyState === WebSocket.OPEN) {
        try {
          targetWebSocket.send(event.data);
          console.log('Successfully sent message to gemini');
        } catch (error) {
          console.error('Error sending to gemini:', error);
        }
     } else {
       // 如果连接还未建立，将消息加入待处理队列
       console.log('Connection not ready, queueing message');
       pendingMessages.push(event.data);
     }
   });
 
   targetWebSocket.addEventListener("message", (event) => {
     console.log('Received message from gemini:', {
     dataPreview: typeof event.data === 'string' ? event.data.slice(0, 200) : 'Binary data',
     dataType: typeof event.data,
     timestamp: new Date().toISOString()
     });
     
     try {
     if (proxy.readyState === WebSocket.OPEN) {
       proxy.send(event.data);
       console.log('Successfully forwarded message to client');
     }
     } catch (error) {
     console.error('Error forwarding to client:', error);
     }
   });
 
   targetWebSocket.addEventListener("close", (event) => {
     console.log('Gemini connection closed:', {
     code: event.code,
     reason: event.reason || 'No reason provided',
     wasClean: event.wasClean,
     timestamp: new Date().toISOString(),
     readyState: targetWebSocket.readyState
     });
     if (proxy.readyState === WebSocket.OPEN) {
     proxy.close(event.code, event.reason);
     }
   });
 
   proxy.addEventListener("close", (event) => {
     console.log('Client connection closed:', {
     code: event.code,
     reason: event.reason || 'No reason provided',
     wasClean: event.wasClean,
     timestamp: new Date().toISOString()
     });
     if (targetWebSocket.readyState === WebSocket.OPEN) {
     targetWebSocket.close(event.code, event.reason);
     }
   });
 
   targetWebSocket.addEventListener("error", (error) => {
     console.error('Gemini WebSocket error:', {
     error: error.message || 'Unknown error',
     timestamp: new Date().toISOString(),
     readyState: targetWebSocket.readyState
     });
   });

 
   return new Response(null, {
   status: 101,
   webSocket: client,
   });
}

/**
 * Handles API requests by proxying them through the worker.mjs module
 * 
 * Delegates API request processing to the specialized API proxy worker,
 * which handles OpenAI-compatible endpoints and forwards them to Google's Gemini API.
 * Provides error handling and appropriate HTTP status codes for failed requests.
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
 * 3. Handle any errors with proper HTTP responses
 * 4. Return processed response or error response
 * 
 * @async
 * @param {Request} request - HTTP request object for API endpoint
 * @param {Object} env - Cloudflare Workers environment bindings
 * @returns {Promise<Response>} Processed API response or error response
 * 
 * @throws {Response} Returns 500 status for module import or processing errors
 * 
 * @example
 * // POST /chat/completions
 * // → Imports ./api_proxy/worker.mjs and delegates processing
 * 
 * @example
 * // GET /models 
 * // → Returns available Gemini models in OpenAI-compatible format
 */
async function handleAPIRequest(request, env) {
  try {
    const worker = await import('./api_proxy/worker.mjs');
    return await worker.default.fetch(request);
  } catch (error) {
    console.error('API request error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStatus = error.status || 500;
    return new Response(errorMessage, {
      status: errorStatus,
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
      }
    });
  }
}