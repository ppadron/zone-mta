'use strict';

// NB! This script is ran as a separate process, so no direct access to the queue, no data
// sharing with other part of the code etc.

const argv = require('minimist')(process.argv.slice(2));
const SendingZone = require('../lib/sending-zone').SendingZone;
const config = require('wild-config');
const log = require('npmlog');
const bounces = require('../lib/bounces');

// initialize plugin system
const plugins = require('../lib/plugins');
plugins.init('sender');

const Sender = require('../lib/sender');
const crypto = require('crypto');

const QueueClient = require('../lib/transport/client');
const queueClient = new QueueClient(config.queueServer);
const RemoteQueue = require('../lib/remote-queue');

const senders = new Set();

let cmdId = 0;
let responseHandlers = new Map();

let closing = false;
let zone;

// Read command line arguments
let currentZone = argv.senderName;
let clientId = argv.senderId || crypto.randomBytes(10).toString('hex');

// Find and setup correct Sending Zone
Object.keys(config.zones || {}).find(zoneName => {
    let zoneData = config.zones[zoneName];
    if (zoneName === currentZone) {
        zone = new SendingZone(zoneName, zoneData, false);
        return true;
    }
    return false;
});

if (!zone) {
    require('../lib/logger'); // eslint-disable-line global-require
    log.error('Sender/' + process.pid, 'Unknown Zone %s', currentZone);
    return process.exit(5);
}

let logName = 'Sender/' + zone.name + '/' + process.pid;
log.level = 'logLevel' in zone ? zone.logLevel : config.log.level;
require('../lib/logger'); // eslint-disable-line global-require
log.info(logName, '[%s] Starting sending for %s', clientId, zone.name);

process.title = config.ident + ': sender/' + currentZone;

config.on('reload', () => {
    bounces.reloadBounces();
    log.info(logName, '[%s] Configuration reloaded', clientId);
});

let sendCommand = (cmd, callback) => {
    let id = ++cmdId;
    let data = {
        req: id
    };

    if (typeof cmd === 'string') {
        cmd = {
            cmd
        };
    }

    Object.keys(cmd).forEach(key => (data[key] = cmd[key]));
    responseHandlers.set(id, callback);
    queueClient.send(data);
};

queueClient.connect(err => {
    if (err) {
        log.error(logName, 'Could not connect to Queue server. %s', err.message);
        process.exit(1);
    }

    queueClient.on('close', () => {
        if (!closing) {
            log.error(logName, 'Connection to Queue server closed unexpectedly');
            process.exit(1);
        }
    });

    queueClient.on('error', err => {
        if (!closing) {
            log.error(logName, 'Connection to Queue server ended with error %s', err.message);
            process.exit(1);
        }
    });

    queueClient.onData = (data, next) => {
        let callback;
        if (responseHandlers.has(data.req)) {
            callback = responseHandlers.get(data.req);
            responseHandlers.delete(data.req);
            setImmediate(() => callback(data.error ? new Error(data.error) : null, !data.error && data.response));
        }
        next();
    };

    // Notify the server about the details of this client
    queueClient.send({
        cmd: 'HELLO',
        zone: zone.name,
        id: clientId
    });

    let queue = new RemoteQueue();
    queue.init(sendCommand, err => {
        if (err) {
            log.error(logName, 'Queue error %s', err.message);
            return process.exit(1);
        }

        plugins.handler.queue = queue;

        plugins.handler.load(() => {
            log.info(logName, '%s plugins loaded', plugins.handler.loaded.length);
        });

        // start sending instances
        for (let i = 0; i < zone.connections; i++) {
            // use artificial delay to lower the chance of races
            setTimeout(() => {
                let sender = new Sender(clientId, i + 1, zone, sendCommand, queue);
                senders.add(sender);
                sender.once('error', err => {
                    log.info(logName, 'Sender error. %s', err.message);
                    closing = true;
                    senders.forEach(sender => {
                        sender.removeAllListeners('error');
                        sender.close();
                    });
                    senders.clear();
                });
            }, Math.random() * 1500);
        }
    });
});
