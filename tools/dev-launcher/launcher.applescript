on run
	set appPath to POSIX path of (path to me)
	set appBundlePath to do shell script "/usr/bin/dirname " & quoted form of (appPath & "Contents")
	set projectDir to do shell script "/usr/bin/dirname " & quoted form of appBundlePath
	set controller to projectDir & "/tools/dev-launcher/control.sh"
	set controllerCommand to quoted form of controller

	try
		set currentStatus to do shell script controllerCommand & " status"

		if currentStatus starts with "RUNNING" then
			set chosenButton to button returned of (display dialog "Video Reverse Prompt 开发版正在运行" with title "Video Reverse Prompt 开发启动器" buttons {"打开日志", "重新启动", "关闭项目"} default button "打开日志" with icon note)

			if chosenButton is "关闭项目" then
				do shell script controllerCommand & " stop"
				display notification "开发版已关闭" with title "Video Reverse Prompt"
			else if chosenButton is "重新启动" then
				set resultText to do shell script controllerCommand & " restart"
				my handleStartResult(resultText, controllerCommand)
			else
				my openLog(controllerCommand)
			end if
		else
			set resultText to do shell script controllerCommand & " start"
			my handleStartResult(resultText, controllerCommand)
		end if
	on error errorMessage number errorNumber
		if errorNumber is not -128 then
			display alert "启动器执行失败" message errorMessage as critical
		end if
	end try
end run

on handleStartResult(resultText, controllerCommand)
	if resultText starts with "STARTED" or resultText starts with "ALREADY_RUNNING" then
		display notification "开发版正在启动，窗口稍后出现" with title "Video Reverse Prompt"
	else if resultText is "NEEDS_INSTALL" then
		display alert "尚未安装项目依赖" message "请先在项目目录执行 npm install。" as warning
	else if resultText is "MISSING_NPM" then
		display alert "找不到 Node.js / npm" message "请先安装 Node.js 22 或更高版本。" as warning
	else if resultText is "MISSING_RUST" then
		display alert "找不到 Rust" message "请先安装 Rust stable。" as warning
	else
		display alert "项目未能启动" message "请打开运行日志查看具体错误。" as critical
		my openLog(controllerCommand)
	end if
end handleStartResult

on openLog(controllerCommand)
	set logPath to do shell script controllerCommand & " log-path"
	do shell script "/usr/bin/touch " & quoted form of logPath
	do shell script "/usr/bin/open -a TextEdit " & quoted form of logPath
end openLog
