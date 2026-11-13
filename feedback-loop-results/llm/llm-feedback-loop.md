● /gt-story-planner for story 111 stopped without producing us.json.

  - Cause: The tracker has no content for story 111. The title is the placeholder item-111, the description is empty, and there are no acceptance criteria. The skill requires ACs from the tracker, or
    derived from the description, and it doesn't invent them.
  - Gate result: The us.json validation hook failed after the maximum 3 retries.
  - Run ID: gtc-20261111-111111
  - Artifacts:
    - .workflow-artifacts/gtc-20261111-111111/tracker-source.json holds the verbatim tracker output.
    - us.validation.json in the same folder has the validator's details.

  To unblock, you can do either of these:
  1. Add a real title, description and ACs to item 111 in the tracker, then re-run /gt-story-planner 111.
  2. Paste the story text directly with /gt-story-planner --us-text "<story>".

  If 111 was a typo, tell me the correct ID and I'll re-run it.
