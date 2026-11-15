ALTER TABLE knowledge.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.document_chunks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_chunks_tenant_isolation ON knowledge.document_chunks;
CREATE POLICY document_chunks_tenant_isolation ON knowledge.document_chunks
  USING (
    current_setting('app.allow_all_tenants', true) = 'true'
    OR (
      current_setting('app.tenant_id', true) IS NOT NULL
      AND tenant_id IS NOT DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')
    )
  )
  WITH CHECK (
    current_setting('app.tenant_id', true) IS NOT NULL
    AND tenant_id IS NOT DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')
  );
