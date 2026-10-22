-- S6 / F3 upload (additive). One new SECURITY DEFINER function, the upload twin of
-- start_source_extraction (migration 20261020231312): same checks, same single usage count, plus
-- the file. Direct writes to sources stay revoked (20261021115926).
--
-- Flow: the browser uploads the file to the private bucket at sources/{uid}/{source_id} (storage
-- RLS: own folder only, profile must exist); the server action downloads it with the user's client,
-- sniffs and reads it (unpdf), and only a readable text-layer file reaches this function. The
-- source id is chosen before the upload so the object path and the row agree; the function refuses
-- a path whose object does not exist, so a source never points at a missing file.

create function public.start_upload_extraction(
  p_source_id uuid, p_text text, p_title text, p_reference_date date, p_now timestamptz,
  p_mime_type text, p_page_offsets int[], p_model text, p_prompt_version text, p_schema_version text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_ref date := p_reference_date;
  v_ref_source text := 'user';
  v_path text;
  v_extraction uuid;
  v_n int;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_source_id is null then raise exception 'source id required' using errcode = '22023'; end if;
  if p_mime_type is null or p_mime_type not in ('application/pdf', 'text/plain', 'text/markdown') then
    raise exception 'unsupported mime type' using errcode = '22023';
  end if;
  if private.is_blank(p_text) or char_length(p_text) > 30000 then
    raise exception 'invalid text' using errcode = '22023';
  end if;
  if p_title is not null and char_length(p_title) > 120 then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_reference_date is not null and (p_reference_date < date '1900-01-01' or p_reference_date > date '2100-12-31') then
    raise exception 'invalid reference date' using errcode = '22023';
  end if;

  -- Page map: PDFs only; 1–30 pages, starting at 0, never decreasing, inside the text.
  v_n := coalesce(cardinality(p_page_offsets), 0);
  if p_mime_type = 'application/pdf' then
    if v_n < 1 or v_n > 30 or p_page_offsets[1] <> 0
       or array_position(p_page_offsets, null) is not null
       or exists (
         select 1 from generate_subscripts(p_page_offsets, 1) i
         where p_page_offsets[i] > char_length(p_text) or (i > 1 and p_page_offsets[i] < p_page_offsets[i - 1])
       ) then
      raise exception 'invalid page offsets' using errcode = '22023';
    end if;
  elsif v_n > 0 then
    raise exception 'page offsets are for PDFs only' using errcode = '22023';
  end if;

  -- The file must already be in the caller's own folder (uploaded under storage RLS).
  v_path := v_uid::text || '/' || p_source_id::text;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'sources' and o.name = v_path) then
    raise exception 'uploaded file not found' using errcode = 'P0002';
  end if;

  if v_ref is null then
    select p.timezone into v_tz from public.profiles p where p.id = v_uid;
    if not found then raise exception 'no profile' using errcode = '42501'; end if;
    v_ref := (p_now at time zone v_tz)::date;
    v_ref_source := 'defaulted';
  end if;

  -- One count per source submission; any failure below rolls the count back with it.
  if not public.consume_usage('extraction') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  insert into public.sources (id, user_id, kind, title, text_content, storage_path, mime_type,
                              reference_date, reference_date_source, page_offsets, pipeline_attempts)
  values (p_source_id, v_uid, 'upload', nullif(btrim(p_title), ''), p_text, v_path, p_mime_type,
          v_ref, v_ref_source, case when v_n > 0 then p_page_offsets end, 1);

  insert into public.extractions (user_id, source_id, status, stage, model, prompt_version, schema_version, via_pipeline)
  values (v_uid, p_source_id, 'running', 'reading', p_model, p_prompt_version, p_schema_version, true)
  returning id into v_extraction;

  return jsonb_build_object('source_id', p_source_id, 'extraction_id', v_extraction);
end;
$$;

revoke all on function
  public.start_upload_extraction(uuid, text, text, date, timestamptz, text, int[], text, text, text)
from public, anon;
grant execute on function
  public.start_upload_extraction(uuid, text, text, date, timestamptz, text, int[], text, text, text)
to authenticated;
