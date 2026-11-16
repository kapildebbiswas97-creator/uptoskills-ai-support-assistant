-- 005-supabase-auth-roles-and-hook.sql
-- UpToSkills AI Support Assistant: Supabase Auth Roles and Custom Access Token Hook
-- Enforces server-controlled role and tenant claims for authenticated Supabase JWTs.

-- 1. Create table for trusted user roles and tenant bindings
CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('super_admin', 'admin', 'support_agent', 'knowledge_manager', 'user')),
  tenant_id text NULL,
  assigned_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON public.user_roles (user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_tenant_id ON public.user_roles (tenant_id) WHERE tenant_id IS NOT NULL;

-- 2. Force Row Level Security on the role assignment table
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles FORCE ROW LEVEL SECURITY;

-- Users may only read their own role assignments
DROP POLICY IF EXISTS user_roles_read_own ON public.user_roles;
CREATE POLICY user_roles_read_own ON public.user_roles
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Supabase Auth calls the hook as supabase_auth_admin. Its only table access is
-- SELECT, constrained to the row selected by user_id inside the hook.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    EXECUTE 'DROP POLICY IF EXISTS user_roles_auth_hook_read ON public.user_roles';
    EXECUTE 'CREATE POLICY user_roles_auth_hook_read ON public.user_roles FOR SELECT TO supabase_auth_admin USING (true)';
  END IF;
END $$;

-- Prevent any direct modification by clients (only service role or SECURITY DEFINER procedures)
REVOKE ALL ON TABLE public.user_roles FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.user_roles TO authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT SELECT ON TABLE public.user_roles TO supabase_auth_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.user_roles TO service_role;
  END IF;
END $$;

-- 3. Automatic least-privilege role assignment trigger for new sign-ups
CREATE OR REPLACE FUNCTION public.handle_new_user_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
BEGIN
  -- New sign-ups receive strictly the least-privileged permitted role ('user')
  INSERT INTO public.user_roles (user_id, role, tenant_id)
  VALUES (NEW.id, 'user', NULL)
  ON CONFLICT (user_id, role) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.handle_new_user_role() FROM PUBLIC, anon, authenticated;

-- Bind trigger to auth.users if the auth schema exists in this Supabase environment
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') AND
     EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'auth' AND c.relname = 'users') THEN
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_role();
  END IF;
END $$;

-- 4. Supabase Custom Access Token Hook
-- Injected by Supabase Auth into access tokens before signing.
-- Reads only server-controlled public.user_roles; never trusts user_metadata.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_claims jsonb;
  v_roles text[];
  v_tenant_id text;
BEGIN
  IF jsonb_typeof(event) <> 'object' OR jsonb_typeof(event->'claims') <> 'object' THEN
    RAISE EXCEPTION 'INVALID_AUTH_HOOK_EVENT';
  END IF;
  v_user_id := (event->>'user_id')::uuid;
  v_claims := event->'claims';

  -- Query trusted user roles from server-controlled table
  SELECT array_agg(DISTINCT role)
  INTO v_roles
  FROM public.user_roles
  WHERE user_id = v_user_id;

  -- New or unassigned users receive strictly the least-privileged 'user' role
  IF v_roles IS NULL OR array_length(v_roles, 1) = 0 THEN
    v_roles := ARRAY['user'];
  END IF;

  -- Query tenant binding from server-controlled table
  SELECT tenant_id
  INTO v_tenant_id
  FROM public.user_roles
  WHERE user_id = v_user_id AND tenant_id IS NOT NULL
  LIMIT 1;

  -- Inject server-verified claims into access token payload
  v_claims := jsonb_set(v_claims, '{roles}', to_jsonb(v_roles));
  IF v_tenant_id IS NOT NULL THEN
    v_claims := jsonb_set(v_claims, '{org_id}', to_jsonb(v_tenant_id));
  ELSE
    v_claims := v_claims - 'org_id';
  END IF;

  IF (SELECT count(DISTINCT tenant_id) FROM public.user_roles WHERE user_id = v_user_id AND tenant_id IS NOT NULL) > 1 THEN
    RAISE EXCEPTION 'INCONSISTENT_USER_TENANT_BINDING';
  END IF;

  RETURN jsonb_build_object('claims', v_claims);
END;
$$;

REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
    GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
  END IF;
END $$;

-- 5. Administrator-only procedure for assigning roles to verified users
CREATE OR REPLACE FUNCTION public.assign_user_role(
  p_target_user_id uuid,
  p_target_role text,
  p_tenant_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
DECLARE
  v_caller_id uuid;
  v_caller_is_super boolean := false;
  v_caller_is_admin boolean := false;
BEGIN
  -- Validate that the assigned role is within the permitted vocabulary
  IF p_target_role IS NULL OR p_target_role NOT IN ('super_admin', 'admin', 'support_agent', 'knowledge_manager', 'user') THEN
    RAISE EXCEPTION 'INVALID_ROLE: Permitted roles are super_admin, admin, support_agent, knowledge_manager, user';
  END IF;

  v_caller_id := auth.uid();

  -- A missing identity on an authenticated caller must never bypass role checks.
  IF current_setting('request.jwt.claim.role', true) = 'authenticated' AND v_caller_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Authenticated role claim is missing a user id.';
  END IF;

  -- If called from an active JWT session, verify caller has administrator role
  IF v_caller_id IS NOT NULL AND current_setting('request.jwt.claim.role', true) <> 'service_role' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles WHERE user_id = v_caller_id AND role = 'super_admin'
    ) INTO v_caller_is_super;

    SELECT EXISTS (
      SELECT 1 FROM public.user_roles WHERE user_id = v_caller_id AND role = 'admin'
    ) INTO v_caller_is_admin;

    IF NOT v_caller_is_super AND NOT v_caller_is_admin THEN
      RAISE EXCEPTION 'UNAUTHORIZED: Only administrators can assign roles.';
    END IF;

    -- Only super_admin can assign administrative roles
    IF p_target_role IN ('super_admin', 'admin') AND NOT v_caller_is_super THEN
      RAISE EXCEPTION 'FORBIDDEN: Only super_admin can grant administrator privileges.';
    END IF;
  END IF;

  -- Ensure target user exists if auth schema is present
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') AND
     EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'auth' AND c.relname = 'users') THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_target_user_id) THEN
      RAISE EXCEPTION 'USER_NOT_FOUND: The target user does not exist in the authentication directory.';
    END IF;
  END IF;

  INSERT INTO public.user_roles (user_id, role, tenant_id, assigned_by, updated_at)
  VALUES (p_target_user_id, p_target_role, p_tenant_id, v_caller_id, now())
  ON CONFLICT (user_id, role) DO UPDATE
  SET tenant_id = EXCLUDED.tenant_id,
      assigned_by = EXCLUDED.assigned_by,
      updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.assign_user_role(uuid, text, text) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.assign_user_role(uuid, text, text) TO service_role;
  END IF;
END $$;
