var fs = require('fs');
var spawn = require('child_process').spawn;
var util = require('util');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var split = require('split');
var concat = require('concat-stream');

// TODO: Make these configurable
var NACL_SDK_ROOT = process.env.NACL_SDK_ROOT;
var RUN_CONTRACT_COMMAND = NACL_SDK_ROOT + '/tools/sel_ldr_x86_32';
var RUN_CONTRACT_ARGS = [
  '-h', 
  '3:3', 
  '-a', 
  '--', 
  NACL_SDK_ROOT + '/toolchain/linux_x86_glibc/x86_64-nacl/lib32/runnable-ld.so', 
  '--library-path', 
  './:' + NACL_SDK_ROOT +'/toolchain/linux_x86_glibc/x86_64-nacl/lib32', 
  './v8_nacl_module.nexe'
];


/**
 * Sandbox class wrapper around Native Client
 */
function Sandbox(opts) {
	var self = this;

	self._filesystem_path = opts.sandbox_filesystem_path;
	self._stdin = opts.stdin_stream || process.stdin;
	self._stdout = opts.stdout_stream || process.stdout;
	self._stderr = opts.stderr_stream || process.stderr;
	self._timeout = opts.timeout || 1000;

	self._native_client_child = null;
	self._ready = false;
	self._message_queue = [];

}
util.inherits(Sandbox, EventEmitter);

/**
 * Run the given code inside the sandbox
 *
 * @param {String} manifest_hash
 * @param {String} code
 */
Sandbox.prototype.run = function(manifest_hash, code) {
	var self = this;

	// Create new sandbox
	var wrapped_code = wrapCode(code);
	self._native_client_child = spawnChildToRunCode(wrapped_code);
	self._native_client_child.on('exit', function(code){
		self.emit('exit', code);
	});

	// Set up stdin, stdout, stderr, ipc
	if (self._stdin) {
		self._stdin.pipe(self._native_client_child.stdio[0]);
	}
	self._native_client_child.stdio[1].pipe(self._stdout);
	self._native_client_child.stdio[2].pipe(self._stderr);
	self._native_client_child.on('message', self._handleMessage.bind(self));
	self._native_client_child.stdio[4].pipe(concat(self._translateVirtualPath.bind(self, manifest_hash)));
};

function wrapCode(code) {
	var wrapped = '';
	wrapped += code;
	wrapped += ';postMessage(JSON.stringify({ type: "__ready" }));';
	return wrapped;
}

function spawnChildToRunCode(code) {
	var args = RUN_CONTRACT_ARGS.slice();
	args.push(code);

	var child = spawn(RUN_CONTRACT_COMMAND, args, { 
	  stdio: [
	    'pipe', 
	    'pipe', 
	    'pipe', 
	    'ipc', 
	    'pipe'
	    ] 
	  });

	return child;
}

/**
 * Kill the sandbox process.
 *
 * @param {String} ['SIGKILL'] message
 */
Sandbox.prototype.kill = function(message){
	var self = this;

	if (!message) {
		message = 'SIGKILL';
	}
	self._native_client_child.kill(message);
};

Sandbox.prototype._handleMessage = function(message) {
	var self = this;

	if (typeof message !== 'object' || typeof message.type !== 'string') {
    self._handleError(new Error('Bad IPC Message: ' + JSON.stringify(message)));
  }

	if (message.type === '__ready') {
    self._ready = true;
    self.emit('ready');
    // Process the _message_queue
    while(self._message_queue.length > 0) {
      self.postMessage(self._message_queue.shift());
    }
  } else {
  	// TODO: serialize this to protect against any malicious messages
  	self.emit('message', message);
  }
};

Sandbox.prototype._handleError = function(error) {
	var self = this;
	self._stderr.write(error.stack);
};

Sandbox.prototype._translateVirtualPath = function(manifest_hash, virtual_path) {
	var self = this;
	console.log('Got request to translate virtual path: ' + virtual_path + ' to a real one for contract: ' + manifest_hash);

	// write response to self._native_client_child.stdio[4]
};

/**
 * Send a message to the code running inside the sandbox.
 *
 * This message will be passed to the sandboxed
 * code's `onmessage` function, if defined.
 * Messages posted before the sandbox is ready will be queued
 */
Sandbox.prototype.postMessage = function(message) {
  var self = this;

  if (self._ready) {
    self._native_client_child.send(message);
  } else {
    self._message_queue.push(message);
  }
};

module.exports = Sandbox;