import { useEffect } from 'react';
import { Modal, Form, Input } from 'antd';
import { GM_getValue, GM_setValue } from '$';
import { DEFAULT_SETTINGS, type ModelSettings } from '../model/config';

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

// 直接用 antd Modal+Form 读写 GM 存储，无自建 settings 包装层
export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [form] = Form.useForm<ModelSettings>();

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      apiKey: GM_getValue('apiKey', DEFAULT_SETTINGS.apiKey),
      model: GM_getValue('model', DEFAULT_SETTINGS.model),
      baseURL: GM_getValue('baseURL', DEFAULT_SETTINGS.baseURL),
    });
  }, [open, form]);

  const handleOk = async () => {
    const v = await form.validateFields();
    GM_setValue('apiKey', v.apiKey ?? '');
    GM_setValue('model', v.model || DEFAULT_SETTINGS.model);
    GM_setValue('baseURL', v.baseURL || DEFAULT_SETTINGS.baseURL);
    onClose();
  };

  return (
    <Modal title="模型设置" open={open} onOk={handleOk} onCancel={onClose} okText="保存" cancelText="取消">
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
      </Form>
    </Modal>
  );
}
