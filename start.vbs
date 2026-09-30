' Go + KataGo web UI - one click launcher (runs the local bridge with no console window)
' The Node service itself opens the browser as soon as it is listening.
Option Explicit

Dim fso, sh, dir, i, port, ok, http, found

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

' Already running? then just open the browser and leave.
If ServiceUp(3210) Then
  sh.Run "http://127.0.0.1:3210/", 1, False
  WScript.Quit 0
End If

' Start the bridge (hidden). server.js opens the browser itself once listening.
On Error Resume Next
sh.Run "node server.js", 0, False
On Error GoTo 0

' Wait up to ~20s for the service to answer (port may shift if 3210 is taken).
found = 0
For i = 1 To 40
  WScript.Sleep 500
  For port = 3210 To 3213
    If ServiceUp(port) Then
      found = port
      Exit For
    End If
  Next
  If found > 0 Then Exit For
Next

If found = 0 Then
  MsgBox "KataGo web service did not start." & vbCrLf & vbCrLf & _
         "Please check:" & vbCrLf & _
         "  " & dir & "\logs\server.log" & vbCrLf & vbCrLf & _
         "Make sure Node.js is installed.", 16, "Go - KataGo"
ElseIf found <> 3210 Then
  ' service landed on a different port; make sure a browser shows it
  sh.Run "http://127.0.0.1:" & found & "/", 1, False
End If

Function ServiceUp(p)
  Dim h
  ServiceUp = False
  On Error Resume Next
  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  h.Open "GET", "http://127.0.0.1:" & p & "/api/status", False
  h.Send
  If Err.Number = 0 Then
    If h.Status = 200 Then ServiceUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function
