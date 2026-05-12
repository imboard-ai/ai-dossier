# Instructions for Local Agent

**You are an AI agent with access to a Vercel project. Your mission: Complete the Dossier Tracing integration.**

---

## 🎯 Your Task

This directory contains a **95% complete implementation** with **4 small gaps** for you to fill. The gaps require knowledge of the target project (auth system, import paths, etc.).

---

## 📋 Quick Start

### 1. Read the Integration Guide

```bash
cat INTEGRATION_GUIDE.md
```

This explains all 4 gaps and how to fill them.

### 2. Fill the Gaps

**Gap #1**: Authentication (`lib/auth.ts`)  
**Gap #2**: Prisma Schema (User/Space models)  
**Gap #3**: Import paths (@/lib vs ~/lib)  
**Gap #4**: Environment variables (Vercel Postgres)  

See `INTEGRATION_GUIDE.md` for detailed instructions.

### 3. Run Tests

```bash
# Make script executable (if not already)
chmod +x test-integration.sh

# Run without auth (basic tests)
./test-integration.sh

# Run with auth (full test suite)
AUTH_TOKEN="your-session-token" ./test-integration.sh
```

### 4. Deploy

```bash
vercel deploy --prod
```

---

## 📁 Files You'll Work With

**In this directory** (examples):
- `INTEGRATION_GUIDE.md` - Your instruction manual
- `test-integration.sh` - Verification test suite
- `api/traces/*.ts` - Complete API routes (copy to target)
- `prisma/schema.prisma` - Trace models (merge with target)
- `lib/auth.example.ts` - Auth examples (adapt one)
- `lib/prisma.ts` - Prisma client (copy to target)

**In target project** (where you'll make changes):
- `lib/auth.ts` - **CREATE**: Adapt from auth.example.ts
- `prisma/schema.prisma` - **MODIFY**: Add Trace/TraceStep models
- `app/api/traces/*` - **CREATE**: Copy API routes
- `.env.local` - **VERIFY**: Vercel Postgres credentials

---

## ✅ Success Criteria

After filling gaps and running tests:

- [ ] All TypeScript compilation succeeds (`npm run build`)
- [ ] Prisma migration successful
- [ ] Test script passes (9/9 tests)
- [ ] Deployed to Vercel
- [ ] Production tests pass

---

## 🚨 If You Get Stuck

### Authentication Issues

**Problem**: Not sure which auth system is used  
**Solution**: 
```bash
grep -r "next-auth\|clerk\|auth0" package.json app/
```
Then use matching example from `lib/auth.example.ts`

### Schema Issues

**Problem**: Don't know User model field names  
**Solution**:
```bash
grep -A 10 "model User" prisma/schema.prisma
```
Adapt Trace model relations to match

### Import Issues

**Problem**: Wrong import paths  
**Solution**:
```bash
cat tsconfig.json | grep "paths"
```
Replace `@/lib` with your project's alias

### Test Failures

**Problem**: Tests fail after implementation  
**Solution**:
```bash
# Run test script with verbose output
./test-integration.sh 2>&1 | tee test-output.log

# Check specific error
cat test-output.log | grep FAIL
```

---

## 📊 Expected Timeline

- **Read Guide**: 5 minutes
- **Fill Gaps**: 5-10 minutes
- **Run Tests**: 2 minutes
- **Deploy**: 1 minute

**Total**: 15-20 minutes

---

## 🎁 What's Already Done

You don't need to write these (they're complete):

✅ All API endpoints (create, get, update, delete, list traces)  
✅ Step append endpoint (real-time logging)  
✅ Prisma schema definitions  
✅ Database queries  
✅ Error handling  
✅ Request validation  
✅ Response formatting  
✅ Test suite  

You only need to adapt to the specific project!

---

## 📝 Reporting

After completion, create a summary:

```
✅ Dossier Tracing Integration Complete

Gaps Filled:
- Auth System: [NextAuth/Clerk/Custom]
- Schema: [Added Trace + TraceStep models]
- Imports: [Used @/lib alias]
- Database: [Vercel Postgres created]

Tests:
- 9/9 passed ✅

Deployment:
- URL: https://your-app.vercel.app/api/traces
- Status: Live and verified

Ready for use!
```

---

## 🚀 Let's Go!

Start with:
```bash
cat INTEGRATION_GUIDE.md
```

Good luck! 🎯
