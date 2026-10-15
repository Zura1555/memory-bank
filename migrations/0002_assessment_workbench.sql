-- Existing checked results have no reviewed dimension rows or next-action inventory.
-- Preserve their claims and capabilities without manufacturing recommendations.
UPDATE jobs
SET assessment_result = jsonb_build_object('comparisons', '[]'::jsonb, 'nextActions', '[]'::jsonb) || assessment_result
WHERE assessment_result IS NOT NULL
  AND (NOT assessment_result ? 'comparisons' OR NOT assessment_result ? 'nextActions');
