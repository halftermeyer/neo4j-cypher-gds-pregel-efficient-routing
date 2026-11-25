# Narrated demo video (French) built from demo-script.md with the demo-video pipeline in video/tools.
# Needs: the stack running (docker compose up -d), `npm run dev`, GEMINI_API_KEY, playwright, ffmpeg.
SCRIPT    ?= demo-script.md
APP_TITLE ?= Network Digital Twin
TOOLS     ?= video/tools

video: video/audio/durations.json          ## narrated video; starts from an emptied demo database
	npm run reset
	python3 $(TOOLS)/record.py --script $(SCRIPT) --find-title "$(APP_TITLE)" --cursor
	python3 $(TOOLS)/assemble.py
	python3 $(TOOLS)/frames.py               # contact sheet for the review round
	npm run test:equiv                       # the recording mutated state: the video is an e2e test

video-silent:                              ## rehearsal: every selector, no TTS credits
	npm run reset
	python3 $(TOOLS)/record.py --script $(SCRIPT) --find-title "$(APP_TITLE)" --cursor --no-audio
	python3 $(TOOLS)/assemble.py --no-audio
	python3 $(TOOLS)/frames.py

video/audio/durations.json: $(SCRIPT)
	python3 $(TOOLS)/tts.py --script $(SCRIPT)

.PHONY: video video-silent
