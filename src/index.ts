import axios from 'axios';
import bodyParser from 'body-parser';
import Express, { NextFunction, Request, Response } from 'express';
import slowDown from 'express-slow-down';

import fs from 'fs';
import path from 'path';

// [webhook id]: reset time
const ratelimits: { [id: string]: number } = {};

// [webhook id]: count
const violations: { [id: string]: { count: number; expires: number } } = {};

// [webhook id]: expiry
const nonExistent: { [id: string]: number } = {};

// [webhook id]: expiry
const badRequests: { [id: string]: { count: number; expires: number } } = {};

const app = Express();
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8')) as {
    port: number;
    trustProxy: boolean;
    autoBlock: boolean;
};
const blocked = JSON.parse(fs.readFileSync('./blocklist.json', 'utf-8')) as { [id: string]: string };

if (config.autoBlock) {
    setInterval(() => {
        let blockedAny = false;

        for (const [k, v] of Object.entries(violations)) {
            if (v.expires < Date.now() / 1000) {
                delete violations[k];
                continue;
            }

            if (v.count > 50) {
                blocked[k] = '[Automated] Ratelimited >50 times within a minute.';
                blockedAny = true;
                console.log('blocked', k, 'for >50 ratelimit violations within 1 minute');
                delete violations[k];
            }
        }

        if (blockedAny) {
            fs.writeFileSync('./blocklist.json', JSON.stringify(blocked, null, 4));
        }
    }, 1000);

    setInterval(() => {
        for (const [k, v] of Object.entries(nonExistent)) {
            if (v < Date.now() / 1000) {
                delete nonExistent[k];
            }
        }
    }, 1000);

    setInterval(() => {
        let blockedAny = false;

        for (const [k, v] of Object.entries(badRequests)) {
            if (v.expires < Date.now() / 1000) {
                delete badRequests[k];
                continue;
            }

            if (v.count > 50) {
                blocked[k] = '[Automated] Made >100 bad requests within 10 minutes.';
                blockedAny = true;
                console.log('blocked', k, 'for >100 bad requests within 10 minutes');
                delete badRequests[k];
            }
        }

        if (blockedAny) {
            fs.writeFileSync('./blocklist.json', JSON.stringify(blocked, null, 4));
        }
    }, 1000);
}

app.set('trust proxy', config.trustProxy);

app.use(
    require('helmet')({
        contentSecurityPolicy: false
    })
);
app.use(bodyParser.json());

// catch spammers that ignore ratelimits in a way that can cause servers to yield for long periods of time
const webhookPostRatelimit = slowDown({
    windowMs: 2000,
    delayAfter: 5,
    delayMs: 1000,
    maxDelayMs: 30000,

    keyGenerator(req, res) {
        return req.params.id ?? req.ip; // use the webhook ID as a ratelimiting key, otherwise use IP
    }
});

const webhookInvalidPostRatelimit = slowDown({
    windowMs: 30000,
    delayAfter: 3,
    delayMs: 1000,
    maxDelayMs: 30000,

    keyGenerator(req, res) {
        return req.params.id ?? req.ip; // use the webhook ID as a ratelimiting key, otherwise use IP
    },

    skip(req, res) {
        return !(res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429); // trigger if it's a 4xx but not a ratelimit
    }
});

const unknownEndpointRatelimit = slowDown({
    windowMs: 10000,
    delayAfter: 5,
    delayMs: 500,
    maxDelayMs: 30000
});

const client = axios.create({
    validateStatus: () => true
});

app.get('/', (req, res) => {
    return res.sendFile(path.resolve('index.html'));
});

app.post('/api/webhooks/:id/:token', webhookPostRatelimit, webhookInvalidPostRatelimit, async (req, res) => {
    const wait = req.query.wait ?? false;
    const threadId = req.query.thread_id;

    const body = req.body;

    if (blocked[req.params.id]) {
        return res.status(403).json({
            proxy: true,
            message: 'This webhook has been blocked. Please contact @Lewis_Schumer on the DevForum.',
            reason: blocked[req.params.id]
        });
    }

    if (nonExistent[req.params.id]) {
        return res.status(404).json({
            proxy: true,
            error: 'This webhook does not exist. Requests to this ID have been blocked temporarily.'
        });
    }

    // if we know this webhook is already ratelimited, don't hit discord but reject the request instead
    const ratelimit = ratelimits[req.params.id];
    if (ratelimit) {
        if (ratelimit < Date.now() / 1000) {
            delete ratelimits[req.params.id];
        } else {
            console.log(`${req.params.id} hit ratelimit`);

            res.setHeader('X-RateLimit-Limit', 5);
            res.setHeader('X-RateLimit-Remaining', 0);
            res.setHeader('X-RateLimit-Reset', ratelimit);

            violations[req.params.id] ??= { count: 0, expires: Date.now() / 1000 + 60 };
            violations[req.params.id].count++;

            return res.status(429).json({
                proxy: true,
                message: 'You have been ratelimited. Please respect the standard Discord ratelimits.'
            });
        }
    }

    const response = await client.post(
        `https://discord.com/api/webhooks/${req.params.id}/${req.params.token}?wait=${wait}${
            threadId ? '&thread_id=' + threadId : ''
        }`,
        body,
        {
            headers: {
                'User-Agent': 'WebhookProxy/1.0 (https://github.com/LewisTehMinerz/webhook-proxy)',
                'Content-Type': 'application/json'
            }
        }
    );

    if (response.status === 404) {
        nonExistent[req.params.id] = Date.now() / 1000 + 60;
        return res.status(404).json({
            proxy: true,
            error: 'This webhook does not exist. Requests to this ID have been blocked temporarily.'
        });
    }

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        badRequests[req.params.id] ??= { count: 0, expires: Date.now() / 1000 + 600 };
        badRequests[req.params.id].count++;
    }

    if (parseInt(response.headers['x-ratelimit-remaining']) === 0) {
        // process ratelimits
        ratelimits[req.params.id] = parseInt(response.headers['x-ratelimit-reset']);
    }

    // forward headers to allow clients to process ratelimits themselves
    for (const header of Object.keys(response.headers)) {
        res.setHeader(header, response.headers[header]);
    }

    res.setHeader('Via', '1.0 WebhookProxy');

    return res.status(response.status).json(response.data);
});

app.use(unknownEndpointRatelimit, (req, res, next) => {
    return res.status(404).json({
        proxy: true,
        message: 'Unknown endpoint.'
    });
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(err);

    return res.status(500).json({
        proxy: true,
        message: 'An error occurred while processing your request.'
    });
});

app.listen(config.port, () => {
    console.log('Up and running.');
});
