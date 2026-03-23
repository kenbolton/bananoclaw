;;; nanoclaw.el --- Emacs interface for NanoClaw AI assistant -*- lexical-binding: t -*-

;; Author: NanoClaw
;; Version: 0.1.0
;; Package-Requires: ((emacs "27.1"))
;; Keywords: ai, assistant, chat
;;
;; Usage:
;;   (load-file "/path/to/nanoclaw/emacs/nanoclaw.el")
;;
;; Doom Emacs (config.el):
;;   (load! "path/to/nanoclaw/emacs/nanoclaw.el")
;;   (map! :leader
;;         :desc "NanoClaw chat"  "a n c" #'nanoclaw-chat
;;         :desc "NanoClaw org"   "a n o" #'nanoclaw-org-send)

;;; Code:

(require 'url)
(require 'json)
(require 'org)

;; ---------------------------------------------------------------------------
;; Customization

(defgroup nanoclaw nil
  "NanoClaw AI assistant interface."
  :group 'tools
  :prefix "nanoclaw-")

(defcustom nanoclaw-host "localhost"
  "Hostname where NanoClaw is running."
  :type 'string
  :group 'nanoclaw)

(defcustom nanoclaw-port 8766
  "Port for the NanoClaw Emacs channel HTTP server."
  :type 'integer
  :group 'nanoclaw)

(defcustom nanoclaw-auth-token nil
  "Bearer token for NanoClaw authentication (matches EMACS_AUTH_TOKEN in .env).
Leave nil if EMACS_AUTH_TOKEN is not set."
  :type '(choice (const nil) string)
  :group 'nanoclaw)

(defcustom nanoclaw-poll-interval 1.5
  "Seconds between response polls when waiting for a reply."
  :type 'number
  :group 'nanoclaw)

(defcustom nanoclaw-agent-name "Andy"
  "Display name for the NanoClaw agent (matches ASSISTANT_NAME in .env)."
  :type 'string
  :group 'nanoclaw)

;; ---------------------------------------------------------------------------
;; Internal state

(defvar nanoclaw--poll-timer nil
  "Timer used to poll for responses in the chat buffer.")

(defvar nanoclaw--last-timestamp 0
  "Epoch ms of the most recently received message.")

(defvar nanoclaw--pending nil
  "Non-nil while waiting for a response.")

;; ---------------------------------------------------------------------------
;; HTTP helpers

(defun nanoclaw--url (path)
  "Return the full URL for PATH on the NanoClaw server."
  (format "http://%s:%d%s" nanoclaw-host nanoclaw-port path))

(defun nanoclaw--headers ()
  "Return alist of HTTP headers for NanoClaw requests."
  (let ((hdrs '(("Content-Type" . "application/json"))))
    (when nanoclaw-auth-token
      (push (cons "Authorization" (concat "Bearer " nanoclaw-auth-token)) hdrs))
    hdrs))

(defun nanoclaw--post (text callback)
  "POST TEXT to NanoClaw and call CALLBACK with the response alist."
  (let* ((url-request-method "POST")
         (url-request-extra-headers (nanoclaw--headers))
         (url-request-data (encode-coding-string
                            (json-encode `((text . ,text)))
                            'utf-8)))
    (url-retrieve
     (nanoclaw--url "/api/message")
     (lambda (status)
       (if (plist-get status :error)
           (message "NanoClaw: POST error %s" (plist-get status :error))
         (goto-char (point-min))
         (re-search-forward "\n\n" nil t)
         (let ((data (ignore-errors (json-read))))
           (funcall callback data))))
     nil t t)))

(defun nanoclaw--poll (since callback)
  "GET messages newer than SINCE (epoch ms) and call CALLBACK with the list."
  (let* ((url-request-method "GET")
         (url-request-extra-headers (nanoclaw--headers)))
    (url-retrieve
     (nanoclaw--url (format "/api/messages?since=%d" since))
     (lambda (status)
       (unless (plist-get status :error)
         (goto-char (point-min))
         (re-search-forward "\n\n" nil t)
         (let* ((data (ignore-errors (json-read)))
                (msgs (cdr (assq 'messages data))))
           (when msgs (funcall callback (append msgs nil))))))
     nil t t)))

;; ---------------------------------------------------------------------------
;; Chat buffer

(defvar nanoclaw-chat-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-<return>") #'nanoclaw-chat-send)
    (define-key map (kbd "RET") #'nanoclaw-chat-send)
    map)
  "Keymap for `nanoclaw-chat-mode'.")

(define-derived-mode nanoclaw-chat-mode fundamental-mode "NanoClaw"
  "Major mode for the NanoClaw chat buffer."
  (setq-local word-wrap t)
  (visual-line-mode 1))

(defun nanoclaw--chat-buffer ()
  "Return the NanoClaw chat buffer, creating it if necessary."
  (or (get-buffer "*NanoClaw*")
      (with-current-buffer (get-buffer-create "*NanoClaw*")
        (nanoclaw-chat-mode)
        (add-hook 'kill-buffer-hook #'nanoclaw--stop-poll nil t)
        (nanoclaw--insert-header)
        (current-buffer))))

(defun nanoclaw--insert-header ()
  "Insert the welcome header into the chat buffer."
  (let ((inhibit-read-only t))
    (insert (propertize
             (format "── NanoClaw (%s) ──────────────────────────────\n\n"
                     nanoclaw-agent-name)
             'face 'font-lock-comment-face))))

(defun nanoclaw--chat-insert (speaker text)
  "Append SPEAKER: TEXT to the chat buffer."
  (with-current-buffer (nanoclaw--chat-buffer)
    (let ((inhibit-read-only t))
      (goto-char (point-max))
      (let ((face (if (string= speaker "You")
                      'font-lock-keyword-face
                    'font-lock-string-face)))
        (insert (propertize (concat speaker ": ") 'face face)))
      (insert text "\n\n")
      (goto-char (point-max)))))

;;;###autoload
(defun nanoclaw-chat ()
  "Open the NanoClaw chat buffer."
  (interactive)
  (pop-to-buffer (nanoclaw--chat-buffer))
  (goto-char (point-max)))

(defun nanoclaw-chat-send ()
  "Send the current line as a message to NanoClaw."
  (interactive)
  (when nanoclaw--pending
    (message "NanoClaw: waiting for previous response...")
    (cl-return-from nanoclaw-chat-send))
  (let* ((line (buffer-substring-no-properties
                (line-beginning-position) (line-end-position)))
         (text (string-trim line)))
    (when (string-empty-p text)
      (user-error "Nothing to send"))
    ;; Replace the input line with the formatted message
    (delete-region (line-beginning-position) (line-end-position))
    (nanoclaw--chat-insert "You" text)
    (setq nanoclaw--pending t)
    (nanoclaw--post text
                    (lambda (data)
                      (when data
                        (setq nanoclaw--last-timestamp
                              (or (cdr (assq 'timestamp data))
                                  nanoclaw--last-timestamp))
                        (nanoclaw--start-poll))))))

(defun nanoclaw--start-poll ()
  "Start polling for new messages."
  (nanoclaw--stop-poll)
  (setq nanoclaw--poll-timer
        (run-with-timer nanoclaw-poll-interval nanoclaw-poll-interval
                        #'nanoclaw--poll-tick)))

(defun nanoclaw--stop-poll ()
  "Stop the polling timer."
  (when nanoclaw--poll-timer
    (cancel-timer nanoclaw--poll-timer)
    (setq nanoclaw--poll-timer nil)))

(defun nanoclaw--poll-tick ()
  "Poll for new messages and insert them into the chat buffer."
  (nanoclaw--poll
   nanoclaw--last-timestamp
   (lambda (msgs)
     (dolist (msg msgs)
       (let ((text (cdr (assq 'text msg)))
             (ts   (cdr (assq 'timestamp msg))))
         (when (and text (> ts nanoclaw--last-timestamp))
           (setq nanoclaw--last-timestamp ts)
           (nanoclaw--chat-insert nanoclaw-agent-name text))))
     (when msgs
       (setq nanoclaw--pending nil)
       (nanoclaw--stop-poll)))))

;; ---------------------------------------------------------------------------
;; Org integration

;;;###autoload
(defun nanoclaw-org-send ()
  "Send the current org subtree to NanoClaw and insert the response as a child.

If a region is active, send the region text instead."
  (interactive)
  (unless (derived-mode-p 'org-mode)
    (user-error "Not in an org-mode buffer"))
  (let ((text (if (use-region-p)
                  (buffer-substring-no-properties (region-beginning) (region-end))
                (nanoclaw--org-subtree-text))))
    (when (string-empty-p (string-trim text))
      (user-error "Nothing to send"))
    (message "NanoClaw: sending to %s..." nanoclaw-agent-name)
    (let ((marker (point-marker))
          (buf    (current-buffer)))
      (nanoclaw--post
       text
       (lambda (data)
         (let ((ts (or (cdr (assq 'timestamp data)) (nanoclaw--now-ms))))
           (nanoclaw--poll-until-response
            ts
            (lambda (response)
              (with-current-buffer buf
                (save-excursion
                  (goto-char marker)
                  (nanoclaw--org-insert-response response))))
            (lambda ()
              (message "NanoClaw: timed out waiting for response")))))))))

(defun nanoclaw--org-subtree-text ()
  "Return the text of the org subtree at point (heading + body)."
  (org-with-wide-buffer
   (org-back-to-heading t)
   (let ((start (point))
         (end   (progn (org-end-of-subtree t t) (point))))
     (buffer-substring-no-properties start end))))

(defun nanoclaw--org-insert-response (text)
  "Insert TEXT as a child org heading under the current subtree."
  (org-back-to-heading t)
  (let* ((level (org-outline-level))
         (child-stars (make-string (1+ level) ?*))
         (timestamp (format-time-string "[%Y-%m-%d %a %H:%M]")))
    (org-end-of-subtree t t)
    (insert "\n" child-stars " " nanoclaw-agent-name " " timestamp "\n"
            text "\n")))

(defun nanoclaw--now-ms ()
  "Return current time as milliseconds since epoch."
  (let ((time (current-time)))
    (+ (* (+ (* (car time) 65536) (cadr time)) 1000)
       (/ (caddr time) 1000))))

(defun nanoclaw--poll-until-response (since callback timeout-fn &optional attempts)
  "Poll until a message newer than SINCE arrives, then call CALLBACK.
Calls TIMEOUT-FN after 60 attempts (~90s)."
  (let ((n (or attempts 0)))
    (if (>= n 60)
        (funcall timeout-fn)
      (nanoclaw--poll
       since
       (lambda (msgs)
         (let ((fresh (seq-filter (lambda (m) (> (cdr (assq 'timestamp m)) since))
                                  msgs)))
           (if fresh
               (let ((text (mapconcat (lambda (m) (cdr (assq 'text m)))
                                      fresh "\n")))
                 (funcall callback text))
             (run-with-timer nanoclaw-poll-interval nil
                             #'nanoclaw--poll-until-response
                             since callback timeout-fn (1+ n)))))))))

;; ---------------------------------------------------------------------------

(provide 'nanoclaw)
;;; nanoclaw.el ends here
