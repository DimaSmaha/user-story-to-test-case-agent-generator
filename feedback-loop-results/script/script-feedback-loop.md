● /gt-story-planner for story 111 stopped without producing us.json. The story has no content to plan from.

  - Cause: Tracker item 111 has an empty description and empty acceptance criteria. Its title is only the placeholder item-111. The planner didn't invent acceptance criteria, so it wrote no us.json.
  - Gate result: The us-json-gate hook failed after 3 retries because us.json wasn't at .workflow-artifacts/gtc-20261111-111111/us.json.
  - Details: .workflow-artifacts/gtc-20261111-111111/us.validation.json
  
  You can fix this in one of three ways:
  1. Add a description and acceptance criteria to item 111 in the tracker, then run /gt-story-planner 111 again.
  2. Pick a different story ID.
  3. Paste the story text directly with /gt-story-planner --us-text "<title + description + AC>". The skill then writes us.json with "id": "manual".