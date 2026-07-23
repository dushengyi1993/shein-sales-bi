BEGIN;

-- The public webhook worker intentionally cannot mutate LinkOps tasks. The
-- authenticated portal performs exact-identity task reconciliation and may
-- only record one of these bounded outcomes back onto an already-succeeded
-- receipt. No ciphertext, arbitrary receipt update, or business fact write is
-- exposed to the portal role.
CREATE OR REPLACE FUNCTION ops.record_shein_webhook_task_reconciliation(
  p_receipt_id bigint,
  p_action_state text,
  p_task_id text DEFAULT ''
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_state text := btrim(COALESCE(p_action_state, ''));
  v_task_id text := btrim(COALESCE(p_task_id, ''));
  v_rows bigint := 0;
BEGIN
  IF p_receipt_id IS NULL OR p_receipt_id <= 0 THEN
    RAISE EXCEPTION 'invalid webhook receipt id';
  END IF;
  IF v_state NOT IN ('task_readback_attached', 'task_unmatched', 'task_match_ambiguous') THEN
    RAISE EXCEPTION 'invalid webhook task reconciliation state';
  END IF;
  IF length(v_task_id) > 200 THEN
    RAISE EXCEPTION 'invalid webhook task id';
  END IF;

  UPDATE ops.shein_webhook_receipt
  SET action_state=v_state,
      normalized=jsonb_set(
        normalized,
        '{taskReconciliation}',
        jsonb_build_object(
          'state', v_state,
          'taskId', v_task_id,
          'reconciledAt', clock_timestamp()
        ),
        true
      )
  WHERE id=p_receipt_id
    AND status='succeeded'
    AND action_state='event_recorded_no_task_repository'
    AND COALESCE(normalized->>'eventFamily','') IN (
      'product_receive','product_audit','product_audit_all_channels','product_shelves','product_delete_audit'
    );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END
$$;

REVOKE ALL ON FUNCTION ops.record_shein_webhook_task_reconciliation(bigint,text,text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shein_link_ops') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA ops TO shein_link_ops';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ops.record_shein_webhook_task_reconciliation(bigint,text,text) TO shein_link_ops';
  END IF;
END
$$;

COMMENT ON FUNCTION ops.record_shein_webhook_task_reconciliation(bigint,text,text)
IS 'Least-privilege acknowledgement of a verified product webhook to LinkOps task reconciliation outcome.';

COMMIT;
