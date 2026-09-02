import { Request, Response, NextFunction } from 'express';
import { LRUCache } from 'lru-cache';

import { config } from './config.js';

export type AuthenticatedUser = {
    osmUserId: string;
    osmUser: string;
};

const cache = new LRUCache<string, AuthenticatedUser>({
    max: 5000,
    ttl: 12 * 1000 * 60 * 60,
});

declare global {
    namespace Express {
        interface Request {
            user?: AuthenticatedUser;
        }
    }
}

/**
 * Identifies the caller by the OSM access token it sent, so that an upload is credited to whoever
 * took the picture rather than to whichever server relayed it.
 *
 * The token is the one the site already holds for the logged in user - this service never issues
 * credentials of its own, and never trusts a user name that was sent in the request body.
 */
export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ message: 'An OSM access token is required' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: 'Invalid token format' });
    }

    if (config.testMode && token === 'TEST_TOKEN') {
        req.user = { osmUserId: 'test-user-id', osmUser: 'test-user' };
        return next();
    }

    if (config.testMode && token === 'TEST_ADMIN_TOKEN') {
        req.user = { osmUserId: 'test-admin-id', osmUser: 'test-admin' };
        return next();
    }

    const cachedUser = cache.get(token);
    if (cachedUser) {
        req.user = cachedUser;
        return next();
    }

    try {
        const response = await fetch('https://api.openstreetmap.org/api/0.6/user/details.json', {
            headers: {
                Authorization: authHeader,
                Accept: 'application/json',
            }
        });

        if (response.status === 401 || response.status === 403) {
            return res.status(401).json({ message: 'Invalid OSM token' });
        }
        if (!response.ok) {
            console.error(`OSM API returned ${response.status} ${response.statusText}`);
            return res.status(500).json({ message: 'Authentication service unavailable' });
        }

        const data = await response.json() as { user?: { id?: number; display_name?: string } };
        if (!data?.user?.id || !data.user.display_name) {
            console.error('Failed to parse the OSM user out of the response');
            return res.status(401).json({ message: 'Failed to authenticate with OSM' });
        }

        const user = { osmUserId: String(data.user.id), osmUser: data.user.display_name };
        cache.set(token, user);
        req.user = user;
        next();
    } catch (error) {
        console.error('OSM Auth Error:', error);
        return res.status(500).json({ message: 'Authentication service unavailable' });
    }
};
