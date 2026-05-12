// lib/auth.ts
// Authentication middleware for Dossier Tracing API
//
// ADAPT THIS to your existing authentication system!
// This is just an example showing the interface needed.

import { NextRequest } from 'next/server';

/**
 * Authenticate request and return user info
 *
 * Replace this with your actual authentication logic:
 * - NextAuth.js: getServerSession(req, authOptions)
 * - Clerk: auth()
 * - Auth0: getSession(req)
 * - Custom JWT: verifyToken(req.headers.get('authorization'))
 */
export async function authenticate(req: NextRequest) {
  // EXAMPLE 1: NextAuth.js
  // import { getServerSession } from 'next-auth';
  // import { authOptions } from '@/app/api/auth/[...nextauth]/route';
  // const session = await getServerSession(authOptions);
  // if (!session?.user) {
  //   throw new Error('Unauthorized');
  // }
  // return {
  //   userId: session.user.id,
  //   spaceId: session.user.claimedSpace.id,
  //   user: session.user,
  // };

  // EXAMPLE 2: Clerk
  // import { auth } from '@clerk/nextjs';
  // const { userId } = auth();
  // if (!userId) {
  //   throw new Error('Unauthorized');
  // }
  // const user = await clerkClient.users.getUser(userId);
  // return {
  //   userId: user.id,
  //   spaceId: user.publicMetadata.spaceId as string,
  //   user,
  // };

  // EXAMPLE 3: Custom JWT from Authorization header
  // const token = req.headers.get('authorization')?.replace('Bearer ', '');
  // if (!token) {
  //   throw new Error('Unauthorized');
  // }
  // const decoded = verifyJWT(token);
  // return {
  //   userId: decoded.userId,
  //   spaceId: decoded.spaceId,
  //   user: decoded,
  // };

  // EXAMPLE 4: API Key (for testing)
  const apiKey = req.headers.get('x-api-key') || req.headers.get('authorization')?.replace('Bearer ', '');

  if (!apiKey) {
    throw new Error('Unauthorized');
  }

  // In real implementation, validate API key against database
  // const user = await prisma.apiKey.findUnique({
  //   where: { key: apiKey },
  //   include: { user: { include: { space: true } } },
  // });

  // For demo purposes only:
  if (apiKey === process.env.TEST_API_KEY) {
    return {
      userId: 'test-user-id',
      spaceId: 'test-space-id',
      user: {
        id: 'test-user-id',
        email: 'test@example.com',
        name: 'Test User',
      },
    };
  }

  throw new Error('Unauthorized');
}

/**
 * Type definition for authenticated request context
 */
export interface AuthContext {
  userId: string;
  spaceId: string;
  user: {
    id: string;
    email: string;
    name?: string | null;
    [key: string]: any;
  };
}
