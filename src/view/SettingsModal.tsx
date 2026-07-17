import { useEffect } from 'react';
import { Modal, Form, Input, Select } from 'antd';
import { getConfig, saveConfig, type AppConfig } from '../model/config';

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

// 直接用 antd Modal+Form 读写 config blob，无自建 settings 包装层
export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [form] = Form.useForm<AppConfig>();

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue(getConfig());
  }, [open, form]);

  const handleOk = async () => {
    const v = await form.validateFields();
    saveConfig(v);
    onClose();
  };

  return (
    <Modal title="设置" open={open} onOk={handleOk} onCancel={onClose} okText="保存" cancelText="取消">
      <Form form={form} layout="vertical">
        <Form.Item label="API Key" name="apiKey" rules={[{ required: true, message: '请输入 API Key' }]}>
          <Input.Password placeholder="sk-..." autoComplete="off" />
        </Form.Item>
        <Form.Item label="模型" name="model">
          <Input placeholder="gpt-4o-mini" />
        </Form.Item>
        <Form.Item label="Base URL" name="baseURL" tooltip="OpenAI 兼容端点，可填 OpenRouter / LMStudio 等">
          <Input placeholder="https://api.openai.com/v1" />
        </Form.Item>
        <Form.Item label="主题" name="theme">
          <Select
            options={[
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
